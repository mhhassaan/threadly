import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { fetchApp } from './helpers'
import { applyAuthMigrations, applyMigration } from './migrations'
import { createAuth } from '../../src/server/auth/auth'
import { requireUser } from '../../src/server/auth/session'
import type { Platform } from '../../src/server/platform'
import type { OwnedThread, ThreadSnapshot } from '../../src/lib/account-thread'
import type { ThreadRecord } from '../../src/lib/thread'
import {
  handleLibrary,
  handleThread,
  handleComments,
  handleSettings,
} from '../../src/server/data/api'
import readingMigration from '../../drizzle/migrations/0003_reading.sql?raw'
import importMigration from '../../drizzle/migrations/0004_import.sql?raw'
import turnMigration from '../../drizzle/migrations/0006_turns.sql?raw'
import discussionUi from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
import openingAdmissions from '../../drizzle/migrations/0008_opening_admissions.sql?raw'
import { saveReadProgress, saveThread } from '../../src/server/data/threads'
import { summarize } from '../../src/lib/summary'

const base = 'http://127.0.0.1:4176'
let platform: Platform
let messages: { text: string }[]
let background: Promise<unknown>[]
let alice: string
let bob: string
let aliceId: string
const record = (): ThreadRecord => ({
  id: crypto.randomUUID(),
  title: 'Private reading',
  posts: ['First post', 'Second post'],
  sourceUrl: 'https://example.invalid/article',
  source: { name: 'Example', handle: 'example' },
  media: [
    {
      type: 'image',
      url: 'https://example.invalid/image.png',
      alt: 'Original image',
      postIndex: 1,
    },
  ],
  interactions: {
    '0': {
      liked: true,
      replies: [{ text: 'Legacy reply', date: '2026-10-01' }],
    },
  },
  sourceText: 'Immutable original source',
  date: '2026-10-01',
})
async function login() {
  const auth = createAuth(platform)
  const person = {
    email: `${crypto.randomUUID()}@example.invalid`,
    name: 'Reader',
    password: crypto.randomUUID() + crypto.randomUUID(),
  }
  const post = (path: string) =>
    auth.handler(
      new Request(`${base}/api/auth/${path}`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify(person),
      }),
    )
  expect((await post('sign-up/email')).status).toBe(200)
  await Promise.all(background)
  const link = messages.at(-1)!.text.match(/http[^\s]+/)![0]
  expect((await auth.handler(new Request(link))).status).toBe(302)
  const signedIn = await post('sign-in/email')
  expect(signedIn.status).toBe(200)
  return signedIn.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ')
}
function call(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = alice,
  origin = base,
  contentType = 'application/json',
) {
  const request = new Request(`${base}${path}`, {
    method,
    headers: { cookie, origin, 'content-type': contentType },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (path === '/api/settings') return handleSettings(request, platform)
  if (path.startsWith('/api/threads/'))
    return handleThread(request, platform, path.split('/').at(-1)!)
  return path === '/api/comments'
    ? handleComments(request, platform)
    : handleLibrary(request, platform)
}
async function create(cookie = alice) {
  const response = await call(
    '/api/library',
    'POST',
    { record: record() },
    cookie,
  )
  expect(response.status).toBe(201)
  return response.json() as Promise<OwnedThread>
}
const threadPath = (t: OwnedThread) => `/api/threads/${t.id}`
const comment = (
  t: OwnedThread,
  postIndex = 0,
  parentId: string | null = null,
) => ({
  id: crypto.randomUUID(),
  threadId: t.id,
  postId: t.posts[postIndex].id,
  parentId,
  text: 'My comment',
})
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  await applyMigration(env.DB, readingMigration)
  await applyMigration(env.DB, importMigration)
  await applyMigration(env.DB, turnMigration)
  await applyMigration(env.DB, discussionUi)
  await applyMigration(env.DB, openingAdmissions)
})
beforeEach(async () => {
  for (const table of [
    'owned_threads',
    'session',
    'account',
    'verification',
    'user',
    'rate_limit',
  ])
    await env.DB.prepare(`DELETE FROM "${table}"`).run()
  messages = []
  background = []
  platform = {
    db: env.DB,
    env: {
      authUrl: base,
      authSecret: crypto.randomUUID() + crypto.randomUUID(),
      emailTransport: 'capture',
      dev: true,
      devMailUrl: 'http://127.0.0.1:4187',
      resendFrom: '',
      resendApiKey: '',
      deepseekApiKey: '',
      aiEnabled: false,
      aiDailySpendLimitUsd: 0,
    },
    waitUntil(work) {
      background.push(work)
    },
  }
  // Only outbound mail is captured; authentication, sessions, handlers and D1 remain real.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    messages.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 'captured' })
  })
  alice = await login()
  bob = await login()
  aliceId = (
    await requireUser(
      new Request(base, { headers: { cookie: alice } }),
      platform,
    )
  ).userId
})
afterEach(() => vi.restoreAllMocks())

// Removing route authentication would expose the private library.
test('private_route_requires_session', async () => {
  vi.mocked(fetch).mockRestore()
  expect((await fetchApp('/api/library')).status).toBe(401)
  for (const response of [
    await call('/api/library', 'GET', undefined, ''),
    await call('/api/comments', 'POST', {}, ''),
    await call(`/api/threads/${crypto.randomUUID()}`, 'GET', undefined, ''),
  ]) {
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  }
})

// Catches missing owner predicates on each read and mutation, including lists.
test('owner_isolation', async () => {
  const owned = await create()
  expect(owned.ownerId).toBe(aliceId)
  expect(owned.revision).toBe(1)
  expect(owned.sourceRevision).toBe(1)
  const list = await call('/api/library', 'GET', undefined, bob)
  expect(await list.json()).toEqual({ threads: [], nextCursor: null })
  for (const response of [
    await call(threadPath(owned), 'GET', undefined, bob),
    await call(
      threadPath(owned),
      'PATCH',
      {
        expectedRevision: 1,
        posts: [{ id: owned.posts[0].id, text: 'Stolen' }],
      },
      bob,
    ),
    await call(
      threadPath(owned),
      'PATCH',
      { expectedRevision: 1, readPostId: owned.posts[0].id },
      bob,
    ),
    await call('/api/comments', 'POST', comment(owned), bob),
    await call(threadPath(owned), 'DELETE', {}, bob),
  ]) {
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  }
  expect((await call(threadPath(owned))).status).toBe(200)
})

// Catches lost updates, unstable post IDs and overwriting source/media/legacy reactions.
test('stale_edit_preserves_server', async () => {
  const owned = await create()
  const patch = (text: string) =>
    call(threadPath(owned), 'PATCH', {
      expectedRevision: 1,
      posts: [{ id: owned.posts[0].id, text }],
    })
  const results = await Promise.all([patch('Winning A'), patch('Winning B')])
  expect(results.map((x) => x.status).sort()).toEqual([200, 409])
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.thread.revision).toBe(2)
  expect(snapshot.thread.posts[0].revision).toBe(2)
  expect(snapshot.thread.posts[1].revision).toBe(1)
  expect(snapshot.thread.posts.map((x) => x.id)).toEqual(
    owned.posts.map((x) => x.id),
  )
  expect(snapshot.thread.record.posts[0]).toMatch(/^Winning [AB]$/)
  expect(snapshot.thread.record.sourceText).toBe('Immutable original source')
  expect(snapshot.thread.record.media).toEqual(owned.record.media)
  expect(snapshot.thread.record.interactions).toEqual(owned.record.interactions)
  expect(snapshot.thread.sourceRevision).toBe(1)
})

// Catches parent validation checking only thread rather than the exact target post.
test('parent_must_share_post', async () => {
  const owned = await create()
  const parent = comment(owned)
  expect((await call('/api/comments', 'POST', parent)).status).toBe(201)
  expect(
    (await call('/api/comments', 'POST', comment(owned, 1, parent.id))).status,
  ).toBe(400)
  const foreign = await create(bob)
  const foreignComment = comment(foreign)
  expect(
    (await call('/api/comments', 'POST', foreignComment, bob)).status,
  ).toBe(201)
  expect(
    (await call('/api/comments', 'POST', comment(owned, 0, foreignComment.id)))
      .status,
  ).toBe(400)
  expect(
    (
      await call('/api/comments', 'POST', {
        ...comment(owned),
        postId: foreign.posts[0].id,
      })
    ).status,
  ).toBe(400)
  expect(
    (await call('/api/comments', 'POST', comment(owned, 0, parent.id))).status,
  ).toBe(201)
})

// Catches duplicated comments under retries and accepting conflicting IDs or AI impersonation.
test('comment_idempotency', async () => {
  const owned = await create()
  const input = comment(owned)
  const responses = await Promise.all([
    call('/api/comments', 'POST', input),
    call('/api/comments', 'POST', input),
  ])
  expect(responses.every((x) => x.status === 201)).toBe(true)
  const values = await Promise.all(responses.map((x) => x.json()))
  expect(values[0]).toEqual(values[1])
  expect(values[0]).toMatchObject({
    id: input.id,
    authorKind: 'human',
    authorId: aliceId,
    sequence: 1,
    turnId: null,
    passageIds: [],
  })
  expect(
    (await call('/api/comments', 'POST', { ...input, text: 'Changed payload' }))
      .status,
  ).toBe(409)
  expect(
    (
      await call('/api/comments', 'POST', {
        ...comment(owned),
        authorKind: 'ai',
        authorId: 'fake',
      })
    ).status,
  ).toBe(400)
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.comments).toHaveLength(1)
})

// Catches dropping progress, wrong-post progress, reaction loss and incomplete dependency cleanup.
test('read_progress_roundtrip', async () => {
  const owned = await create()
  expect(
    (
      await call(threadPath(owned), 'PATCH', {
        expectedRevision: 1,
        readPostId: owned.posts[1].id,
        interactions: { '1': { bookmarked: true, replies: [] } },
      })
    ).status,
  ).toBe(200)
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.readPostId).toBe(owned.posts[1].id)
  expect(Date.parse(snapshot.readAt!)).toBeGreaterThan(0)
  expect(snapshot.thread.record.interactions['1'].bookmarked).toBe(true)
  expect(
    (
      await call(threadPath(owned), 'PATCH', {
        expectedRevision: 2,
        readPostId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400)
  expect((await call('/api/comments', 'POST', comment(owned))).status).toBe(201)
  expect((await call(threadPath(owned), 'DELETE', {})).status).toBe(204)
  expect((await call(threadPath(owned))).status).toBe(404)
  for (const table of ['owned_posts', 'comments', 'reading_progress']) {
    expect(
      await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first(),
    ).toEqual({ count: 0 })
  }
})

// Catches session gating omitted on a route or CSRF/oversize/unknown-field validation bypass.
test('private_mutations_reject_untrusted_or_non_json_requests', async () => {
  const owned = await create()
  const mutations: [string, string, unknown][] = [
    ['/api/library', 'POST', { record: record() }],
    [
      threadPath(owned),
      'PATCH',
      { expectedRevision: 1, readPostId: owned.posts[0].id },
    ],
    [threadPath(owned), 'DELETE', {}],
    ['/api/comments', 'POST', comment(owned)],
  ]
  for (const [path, method, body] of mutations) {
    expect(
      (await call(path, method, body, alice, 'https://hostile.invalid')).status,
    ).toBe(403)
    expect((await call(path, method, body, alice, '')).status).toBe(403)
    expect(
      (await call(path, method, body, alice, base, 'text/plain')).status,
    ).toBe(415)
  }
  expect(
    (await call('/api/library', 'POST', { record: record(), ownerId: aliceId }))
      .status,
  ).toBe(400)
  expect(
    (
      await call('/api/library', 'POST', {
        record: { ...record(), sourceText: 'x'.repeat(1_100_000) },
      })
    ).status,
  ).toBe(413)
  expect(
    (
      await call('/api/comments', 'POST', {
        ...comment(owned),
        text: 'x'.repeat(2001),
      })
    ).status,
  ).toBe(400)
  await env.DB.prepare('UPDATE "user" SET email_verified = 0 WHERE id = ?')
    .bind(aliceId)
    .run()
  for (const [path, method, body] of [
    ['/api/library', 'GET', undefined],
    [threadPath(owned), 'GET', undefined],
    ...mutations,
  ] as [string, string, unknown][]) {
    expect((await call(path, method, body)).status).toBe(403)
  }
})

// Catches an unbounded list or a cursor that skips/duplicates records across pages.
test('library_pages_are_bounded_and_owner_scoped', async () => {
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  const ids: string[] = []
  for (let i = 0; i < 51; i++) {
    const input = record()
    ids.push(input.id)
    await saveThread(platform, user, input, null)
  }
  await create(bob)
  const first = (await (await call('/api/library')).json()) as {
    threads: OwnedThread[]
    nextCursor: string | null
  }
  expect(first.threads).toHaveLength(50)
  expect(first.nextCursor).toBeTruthy()
  const response = await handleLibrary(
    new Request(`${base}/api/library?cursor=${first.nextCursor}`, {
      headers: { cookie: alice },
    }),
    platform,
  )
  const second = (await response.json()) as {
    threads: OwnedThread[]
    nextCursor: string | null
  }
  expect(second.threads).toHaveLength(1)
  expect(second.nextCursor).toBeNull()
  expect([...first.threads, ...second.threads].map((t) => t.id).sort()).toEqual(
    ids.sort(),
  )
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})

// Catches source replacement or unstable IDs through helpers used by the next import task.
test('shared_helpers_preserve_source_and_validate_progress', async () => {
  const owned = await create()
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  const updated = await saveThread(
    platform,
    user,
    {
      ...owned.record,
      posts: ['Edited', 'Second post'],
      sourceText: 'Attempt to replace source',
    },
    1,
  )
  expect(updated.record.sourceText).toBe('Immutable original source')
  expect(updated.posts[0].id).toBe(owned.posts[0].id)
  await expect(
    saveThread(
      platform,
      user,
      { ...owned.record, posts: ['Stale', 'Second post'] },
      1,
    ),
  ).rejects.toMatchObject({ status: 409 })
  await saveReadProgress(platform, user, owned.id, owned.posts[1].id)
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.readPostId).toBe(owned.posts[1].id)
  await expect(
    saveReadProgress(platform, user, owned.id, crypto.randomUUID()),
  ).rejects.toMatchObject({ status: 400 })
  const missingSource = record()
  delete missingSource.sourceText
  const withoutSource = await saveThread(platform, user, missingSource, null)
  expect(Object.hasOwn(withoutSource.record, 'sourceText')).toBe(false)
})

// Catches missing DB constraints even if the route-level validation remains intact.
test('d1_enforces_composite_ownership_and_same_post_parent', async () => {
  const owned = await create()
  const foreign = await create(bob)
  const input = comment(owned)
  expect((await call('/api/comments', 'POST', input)).status).toBe(201)
  const insert = (postId: string, ownerId: string, parentId: string | null) =>
    env.DB.prepare(
      `INSERT INTO comments (id, thread_id, post_id, owner_id, parent_id, author_kind, author_id, text, sequence, created_at) VALUES (?, ?, ?, ?, ?, 'human', ?, 'Blocked', 2, '2026-10-27T00:00:00.000Z')`,
    )
      .bind(crypto.randomUUID(), owned.id, postId, ownerId, parentId, aliceId)
      .run()
  await expect(insert(foreign.posts[0].id, aliceId, null)).rejects.toThrow(
    'FOREIGN KEY constraint failed',
  )
  await expect(
    insert(owned.posts[0].id, foreign.ownerId, null),
  ).rejects.toThrow('FOREIGN KEY constraint failed')
  await expect(insert(owned.posts[1].id, aliceId, input.id)).rejects.toThrow(
    'FOREIGN KEY constraint failed',
  )
})

// Catches leaking setup errors or reporting a missing auth configuration as an internal failure.
test('private_route_reports_unavailable_auth_configuration', async () => {
  platform.env = {
    ...platform.env,
    dev: false,
    authUrl: 'https://example.invalid',
    authSecret: '',
  }
  const response = await call('/api/library')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    code: 'AUTH_UNAVAILABLE',
    message: 'Authentication is not configured',
  })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
})

// Catches new storage limits rejecting complete thoughts produced by the supported 100k-source flow.
test('long_complete_thought_summary_roundtrips_and_edits_without_truncation', async () => {
  const sourceText = 'Observation '.repeat(8300) + 'concludes.'
  const posts = summarize(sourceText, 'balanced', 'auto')
  expect(sourceText.length).toBeLessThanOrEqual(100_000)
  expect(posts).toEqual([sourceText])
  expect(posts[0].length).toBeGreaterThan(20_000)
  const input = { ...record(), sourceText, posts, media: [], interactions: {} }
  const response = await call('/api/library', 'POST', { record: input })
  expect(response.status).toBe(201)
  const owned = (await response.json()) as OwnedThread
  const saved = (await (await call(threadPath(owned))).json()) as ThreadSnapshot
  expect(saved.thread.record.posts).toEqual([sourceText])
  expect(saved.thread.posts[0].text).toBe(sourceText)
  const editedSource = 'Updated observation '.repeat(4900) + 'concludes.'
  const editedPosts = summarize(editedSource, 'balanced', 'auto')
  expect(editedSource.length).toBeLessThanOrEqual(100_000)
  expect(editedPosts).toEqual([editedSource])
  expect(editedPosts[0].length).toBeGreaterThan(20_000)
  const edited = await call(threadPath(owned), 'PATCH', {
    expectedRevision: 1,
    posts: [{ id: owned.posts[0].id, text: editedPosts[0] }],
  })
  expect(edited.status).toBe(200)
  const updated = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(updated.thread.record.posts).toEqual([editedSource])
  expect(updated.thread.posts[0]).toMatchObject({
    id: owned.posts[0].id,
    text: editedSource,
    revision: 2,
  })
  expect(updated.thread.record.sourceText).toBe(sourceText)
})

test('settings_api_is_private_verified_and_origin_checked', async () => {
  const first = await call('/api/settings')
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toBe('private, no-store')
  expect(await first.json()).toEqual({
    aiEnabled: false,
    memoryEnabled: false,
    consentAt: null,
    memoryEpoch: 0,
  })
  expect(
    (
      await call(
        '/api/settings',
        'PATCH',
        { aiEnabled: true },
        alice,
        'https://hostile.invalid',
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await call(
        '/api/settings',
        'PATCH',
        { aiEnabled: true },
        alice,
        base,
        'text/plain',
      )
    ).status,
  ).toBe(415)
  expect(
    (await call('/api/settings', 'PATCH', { consentAt: 'forged' })).status,
  ).toBe(400)
  expect(
    (await call('/api/settings', 'PATCH', { aiEnabled: 'true' })).status,
  ).toBe(400)
  const updated = await call('/api/settings', 'PATCH', {
    aiEnabled: true,
    acknowledgeConsent: true,
  })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject({
    aiEnabled: true,
    memoryEnabled: false,
    consentAt: expect.any(String),
  })
  expect(
    await (await call('/api/settings', 'GET', undefined, bob)).json(),
  ).toEqual({
    aiEnabled: false,
    memoryEnabled: false,
    consentAt: null,
    memoryEpoch: 0,
  })
  expect((await call('/api/settings', 'GET', undefined, '')).status).toBe(401)
  await env.DB.prepare('UPDATE "user" SET email_verified = 0 WHERE id = ?')
    .bind(aliceId)
    .run()
  expect((await call('/api/settings')).status).toBe(403)
})

test('logical_turn_http_owner_origin_and_no_store', async () => {
  const { handleAiTurns } = await import('../../src/server/data/api')
  const thread = await create()
  const input = {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'opening',
    triggerCommentId: null,
  }
  const invoke = (cookie: string, origin: string) =>
    handleAiTurns(
      new Request(base + '/api/ai/turns', {
        method: 'DELETE',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      platform,
      () => platform,
    )
  expect((await invoke(bob, base)).status).toBe(404)
  expect((await invoke(alice, 'https://hostile.invalid')).status).toBe(403)
  const result = await invoke(alice, base)
  expect(result.status).toBe(200)
  expect(result.headers.get('cache-control')).toBe('private, no-store')
  expect(await result.json()).toEqual({ turn: null, cancelled: true })
})

test('logical_status_http_is_owner_scoped_read_only_and_private', async () => {
  const { handleAiTurns } = await import('../../src/server/data/api')
  const thread = await create()
  const query = new URLSearchParams({
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'opening',
    triggerCommentId: '',
  })
  const invoke = (cookie: string) =>
    handleAiTurns(
      new Request(base + '/api/ai/turns?' + query, { headers: { cookie } }),
      platform,
      () => platform,
    )
  expect((await invoke('')).status).toBe(401)
  expect((await invoke(bob)).status).toBe(404)
  const response = await invoke(alice)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ turn: null, cancelled: false })
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_requests').first(),
  ).toEqual({ n: 0 })
})
