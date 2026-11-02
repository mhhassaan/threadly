import { fetchApp } from './helpers'
import discussionMigration from '../../drizzle/migrations/0005_discussion.sql?raw'
import reactionMigration from '../../drizzle/migrations/0012_comment_reactions.sql?raw'
import privacyMigration from '../../drizzle/migrations/0010_privacy.sql?raw'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
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
  handleMemory,
} from '../../src/server/data/api'
import readingMigration from '../../drizzle/migrations/0003_reading.sql?raw'
import importMigration from '../../drizzle/migrations/0004_import.sql?raw'
import turnMigration from '../../drizzle/migrations/0006_turns.sql?raw'
import discussionUi from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
import memoryMigration from '../../drizzle/migrations/0009_memory.sql?raw'
import openingAdmissions from '../../drizzle/migrations/0008_opening_admissions.sql?raw'
import { saveReadProgress, saveThread } from '../../src/server/data/threads'
import * as api from '../../src/server/data/api'

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
  if (path.startsWith('/api/threads/') && path.endsWith('/reactions'))
    return api.handlePostReactions(request, platform, path.split('/').at(-2)!)
  if (path.endsWith('/reactions'))
    return api.handleCommentReactions(
      request,
      platform,
      path.split('/').at(-2)!,
    )
  if (path.endsWith('/progress'))
    return api.handleReadingProgress(request, platform, path.split('/').at(-2)!)
  if (path.startsWith('/api/memory')) return handleMemory(request, platform)
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
  await applyMigration(env.DB, discussionMigration)
  await applyMigration(env.DB, turnMigration)
  await applyMigration(env.DB, discussionUi)
  await applyMigration(env.DB, openingAdmissions)
  await applyMigration(env.DB, memoryMigration)
  await applyMigration(env.DB, privacyMigration)
  await applyMigration(env.DB, reactionMigration)
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

test('own_reaction_roundtrip_and_idempotency', async () => {
  const owned = await create(),
    input = comment(owned)
  await call('/api/comments', 'POST', input)
  const path = `/api/comments/${input.id}/reactions`
  for (let i = 0; i < 2; i++) {
    const response = await call(path, 'PATCH', { liked: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      liked: true,
      reposted: false,
      bookmarked: false,
    })
  }
  await call(path, 'PATCH', { bookmarked: true, liked: false })
  expect(await (await call(path, 'PATCH', {})).json()).toEqual({
    liked: false,
    reposted: false,
    bookmarked: true,
  })
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.commentReactions).toEqual({
    [input.id]: { liked: false, reposted: false, bookmarked: true },
  })
})

test('progress_is_monotonic_by_post_position_under_out_of_order_requests', async () => {
  const owned = await create()
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  await saveReadProgress(platform, user, owned.id, owned.posts[1].id)
  const first = (await (await call(threadPath(owned))).json()) as ThreadSnapshot
  await saveReadProgress(platform, user, owned.id, owned.posts[0].id)
  const second = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(second.readPostId).toBe(owned.posts[1].id)
  expect(second.readAt).toBe(first.readAt)
})

test('foreign_unverified_unknown_fields_or_untrusted_origin_rejected_no_store', async () => {
  const owned = await create(),
    input = comment(owned)
  await call('/api/comments', 'POST', input)
  const reaction = `/api/comments/${input.id}/reactions`,
    progress = `${threadPath(owned)}/progress`
  for (const [path, method, value] of [
    [reaction, 'PATCH', { liked: true }],
    [progress, 'POST', { postId: owned.posts[0].id }],
  ] as const) {
    for (const [cookie, origin, contentType, expected] of [
      [bob, base, 'application/json', 404],
      ['', base, 'application/json', 401],
      [alice, 'https://hostile.invalid', 'application/json', 403],
      [alice, '', 'application/json', 403],
      [alice, base, 'text/plain', 415],
    ] as const) {
      const response = await call(
        path,
        method,
        value,
        cookie,
        origin,
        contentType,
      )
      expect(response.status).toBe(expected)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    expect(
      (await call(path, method, { ...value, ownerId: aliceId })).status,
    ).toBe(400)
    expect((await call(path, 'GET')).status).toBe(405)
  }
  for (const patch of [
    { liked: 1 },
    { liked: null },
    { reposted: 'true' },
    { bookmarked: [] },
    { count: 99 },
  ])
    expect((await call(reaction, 'PATCH', patch)).status).toBe(400)
  expect(
    (await call(`/api/comments/${crypto.randomUUID()}/reactions`, 'PATCH', {}))
      .status,
  ).toBe(404)
  await env.DB.prepare('UPDATE "user" SET email_verified = 0 WHERE id = ?')
    .bind(aliceId)
    .run()
  for (const [path, method, value] of [
    [reaction, 'PATCH', {}],
    [progress, 'POST', { postId: owned.posts[0].id }],
  ] as const)
    expect((await call(path, method, value)).status).toBe(403)
})

test('concurrent_different_reaction_flags_not_lost', async () => {
  const owned = await create(),
    input = comment(owned)
  await call('/api/comments', 'POST', input)
  const path = `/api/comments/${input.id}/reactions`
  const responses = await Promise.all(
    ['liked', 'reposted', 'bookmarked'].map((key) =>
      call(path, 'PATCH', { [key]: true }),
    ),
  )
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
  expect(await (await call(path, 'PATCH', {})).json()).toEqual({
    liked: true,
    reposted: true,
    bookmarked: true,
  })
  await Promise.all([
    call(path, 'PATCH', { liked: false }),
    call(path, 'PATCH', { bookmarked: false }),
  ])
  expect(await (await call(path, 'PATCH', {})).json()).toEqual({
    liked: false,
    reposted: true,
    bookmarked: false,
  })
})

test('conversation_thread_account_deletion_cascades_reactions', async () => {
  for (const scope of ['conversation', 'thread', 'account']) {
    const owned = await create(),
      input = comment(owned)
    await call('/api/comments', 'POST', input)
    await call(`/api/comments/${input.id}/reactions`, 'PATCH', { liked: true })
    if (scope === 'conversation')
      expect(
        (
          await call('/api/comments', 'DELETE', {
            threadId: owned.id,
            postId: owned.posts[0].id,
          })
        ).status,
      ).toBe(204)
    if (scope === 'thread')
      expect((await call(threadPath(owned), 'DELETE', {})).status).toBe(204)
    if (scope === 'account')
      await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
        .bind(aliceId)
        .run()
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM comment_reactions',
      ).first(),
    ).toEqual({ n: 0 })
  }
})

test('reaction_composite_owner_constraints_and_delete_race', async () => {
  const owned = await create(),
    input = comment(owned),
    foreign = await create(bob)
  await call('/api/comments', 'POST', input)
  await expect(
    env.DB.prepare(
      'INSERT INTO comment_reactions (comment_id,thread_id,post_id,owner_id) VALUES (?,?,?,?)',
    )
      .bind(input.id, owned.id, owned.posts[0].id, foreign.ownerId)
      .run(),
  ).rejects.toThrow('FOREIGN KEY constraint failed')
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  const { setCommentReaction } =
    await import('../../src/server/data/comment-reactions')
  await call('/api/comments', 'DELETE', {
    threadId: owned.id,
    postId: owned.posts[0].id,
  })
  await expect(
    setCommentReaction(platform, user, input.id, { liked: true }),
  ).rejects.toMatchObject({ status: 404 })
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM comment_reactions').first(),
  ).toEqual({ n: 0 })
})

test('reading_progress_is_metadata_only', async () => {
  const owned = await create(),
    input = comment(owned)
  await call('/api/comments', 'POST', input)
  const content = () =>
    env.DB.batch(
      [
        'owned_threads',
        'owned_posts',
        'comments',
        'source_passages',
        'memory_evidence',
      ].map((table) => env.DB.prepare(`SELECT * FROM ${table}`)),
    )
  const before = (await content()).map((r) => r.results)
  const response = await call(`${threadPath(owned)}/progress`, 'POST', {
    postId: owned.posts[1].id,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const saved = (await response.json()) as { postId: string; readAt: string }
  expect(saved.postId).toBe(owned.posts[1].id)
  expect(Date.parse(saved.readAt)).toBeGreaterThan(0)
  await call(`/api/comments/${input.id}/reactions`, 'PATCH', { liked: true })
  expect((await content()).map((r) => r.results)).toEqual(before)
  const earlier = await call(`${threadPath(owned)}/progress`, 'POST', {
    postId: owned.posts[0].id,
  })
  expect(earlier.status).toBe(200)
  expect(await earlier.json()).toEqual(saved)
})

test('progress_rejects_foreign_post_and_delete_race', async () => {
  const owned = await create(),
    foreign = await create(bob)
  expect(
    (
      await call(`${threadPath(owned)}/progress`, 'POST', {
        postId: foreign.posts[0].id,
      })
    ).status,
  ).toBe(400)
  expect((await call(`${threadPath(owned)}/progress`, 'POST', {})).status).toBe(
    400,
  )
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  const batch = env.DB.batch.bind(env.DB)
  // Delete after validation but before the atomic INSERT SELECT/return batch.
  const racing = {
    ...platform,
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.prepare('DELETE FROM owned_threads WHERE id = ?')
          .bind(owned.id)
          .run()
        return batch(statements)
      },
    } as D1Database,
  }
  await expect(
    saveReadProgress(racing, user, owned.id, owned.posts[0].id),
  ).rejects.toMatchObject({ status: 404 })
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM reading_progress').first(),
  ).toEqual({ n: 0 })
})

test('GET_status_never_generates', async () => {
  const owned = await create()
  const calls = vi.mocked(fetch).mock.calls.length
  expect((await call(threadPath(owned))).status).toBe(200)
  const query = new URLSearchParams({
    requestId: crypto.randomUUID(),
    threadId: owned.id,
    kind: 'opening',
    triggerCommentId: '',
  })
  const response = await api.handleAiTurns(
    new Request(`${base}/api/ai/turns?${query}`, {
      headers: { cookie: alice },
    }),
    platform,
    () => platform,
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ turn: null, cancelled: false })
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM ai_requests').first(),
  ).toEqual({ n: 0 })
})

test('post_reactions_preserve_legacy_flags_replies_and_metadata_after_stale_editor_save', async () => {
  const owned = await create(),
    path = `${threadPath(owned)}/reactions`
  const response = await call(path, 'PATCH', {
    postId: owned.posts[0].id,
    bookmarked: true,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    liked: true,
    reposted: false,
    bookmarked: true,
  })
  const responses = await Promise.all([
    call(path, 'PATCH', { postId: owned.posts[0].id, liked: false }),
    call(path, 'PATCH', { postId: owned.posts[0].id, reposted: true }),
  ])
  expect(responses.map((r) => r.status)).toEqual([200, 200])
  const edited = await call(threadPath(owned), 'PATCH', {
    expectedRevision: 1,
    interactions: owned.record.interactions,
  })
  expect(edited.status).toBe(409)
  const sourceSave = await call(threadPath(owned), 'PATCH', {
    expectedRevision: 1,
    posts: [{ id: owned.posts[0].id, text: 'Edited source' }],
  })
  expect(sourceSave.status).toBe(200)
  const snapshot = (await sourceSave.json()) as ThreadSnapshot
  expect(snapshot.thread.record.interactions['0']).toEqual({
    liked: false,
    reposted: true,
    bookmarked: true,
    replies: owned.record.interactions['0'].replies,
  })
  expect(
    await (
      await call(path, 'PATCH', { postId: owned.posts[1].id, liked: true })
    ).json(),
  ).toEqual({ liked: true, reposted: false, bookmarked: false })
})

test('post_reactions_are_private_verified_json_origin_guarded_and_cascade', async () => {
  const owned = await create(),
    foreign = await create(bob),
    path = `${threadPath(owned)}/reactions`
  const desired = { postId: owned.posts[0].id, liked: true }
  for (const [cookie, origin, contentType, expected] of [
    [bob, base, 'application/json', 404],
    ['', base, 'application/json', 401],
    [alice, 'https://hostile.invalid', 'application/json', 403],
    [alice, '', 'application/json', 403],
    [alice, base, 'text/plain', 415],
  ] as const) {
    const result = await call(
      path,
      'PATCH',
      desired,
      cookie,
      origin,
      contentType,
    )
    expect(result.status).toBe(expected)
    expect(result.headers.get('cache-control')).toBe('private, no-store')
  }
  for (const input of [
    { ...desired, liked: 'yes' },
    { ...desired, ownerId: aliceId },
    { liked: true },
    { postId: foreign.posts[0].id, liked: true },
  ])
    expect([400, 404]).toContain((await call(path, 'PATCH', input)).status)
  expect((await call(path, 'GET')).status).toBe(405)
  expect((await call(path, 'PATCH', desired)).status).toBe(200)
  const snapshot = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(snapshot.thread.revision).toBe(1)
  expect(snapshot.thread.record.interactions['0'].replies).toEqual(
    owned.record.interactions['0'].replies,
  )
  const library = (await (await call('/api/library')).json()) as {
    threads: OwnedThread[]
  }
  expect(
    library.threads.find((t) => t.id === owned.id)!.record.interactions['0'],
  ).toEqual(snapshot.thread.record.interactions['0'])
  await expect(
    env.DB.prepare(
      'INSERT INTO post_reactions (post_id,thread_id,owner_id) VALUES (?,?,?)',
    )
      .bind(foreign.posts[0].id, owned.id, aliceId)
      .run(),
  ).rejects.toThrow('FOREIGN KEY constraint failed')
  await env.DB.prepare('UPDATE "user" SET email_verified = 0 WHERE id = ?')
    .bind(aliceId)
    .run()
  expect((await call(path, 'PATCH', desired)).status).toBe(403)
  await env.DB.prepare('UPDATE "user" SET email_verified = 1 WHERE id = ?')
    .bind(aliceId)
    .run()
  expect((await call(threadPath(owned), 'DELETE', {})).status).toBe(204)
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM post_reactions').first(),
  ).toEqual({ n: 0 })
  expect((await call(path, 'PATCH', desired)).status).toBe(404)
  const second = await create()
  await call(`${threadPath(second)}/reactions`, 'PATCH', {
    postId: second.posts[0].id,
    bookmarked: true,
  })
  await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(aliceId).run()
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM post_reactions').first(),
  ).toEqual({ n: 0 })
})

test('actual_stale_editor_adapter_omits_unchanged_flags_and_preserves_conflicting_draft', async () => {
  const { saveCloudDraft } = await import('../../src/features/account/library')
  const owned = await create()
  const captured = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  await call(`${threadPath(owned)}/reactions`, 'PATCH', {
    postId: owned.posts[0].id,
    liked: false,
    bookmarked: true,
  })
  const draft = structuredClone(captured.thread.record)
  draft.posts[0] = 'Source edit after metadata'
  let payload: any
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    expect(String(url)).toBe(threadPath(owned))
    payload = JSON.parse(String(init?.body))
    return call(String(url), init?.method, payload)
  })
  const saved = await saveCloudDraft(aliceId, draft, captured)
  expect(payload.interactions).toBeUndefined()
  expect(saved.error).toBeNull()
  expect(saved.snapshot!.thread.record.posts[0]).toBe(
    'Source edit after metadata',
  )
  expect(saved.snapshot!.thread.record.interactions['0']).toMatchObject({
    liked: false,
    bookmarked: true,
  })
  const current = saved.snapshot!
  const conflictDraft = structuredClone(current.thread.record)
  conflictDraft.interactions['0'].liked = true
  const rejected = await saveCloudDraft(aliceId, conflictDraft, current)
  expect(rejected.error?.status).toBe(409)
  expect(rejected.draft).toEqual(conflictDraft)
  expect(rejected.snapshot).toBeNull()
  const authoritative = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  expect(authoritative.thread.revision).toBe(current.thread.revision)
  expect(authoritative.thread.record.interactions['0'].liked).toBe(false)
})

test('legacy_flag_PATCH_before_metadata_and_equal_authoritative_flags_remain_compatible', async () => {
  const owned = await create()
  const beforeMetadata = await call(threadPath(owned), 'PATCH', {
    expectedRevision: 1,
    interactions: { '0': { liked: false, bookmarked: true, replies: [] } },
  })
  expect(beforeMetadata.status).toBe(200)
  expect(
    ((await beforeMetadata.json()) as ThreadSnapshot).thread.record
      .interactions['0'],
  ).toEqual({ liked: false, bookmarked: true, replies: [] })
  await call(`${threadPath(owned)}/reactions`, 'PATCH', {
    postId: owned.posts[0].id,
    reposted: true,
  })
  const authoritative = (await (
    await call(threadPath(owned))
  ).json()) as ThreadSnapshot
  const result = await call(threadPath(owned), 'PATCH', {
    expectedRevision: 2,
    interactions: authoritative.thread.record.interactions,
    posts: [{ id: owned.posts[0].id, text: 'Content with matching flags' }],
  })
  expect(result.status).toBe(200)
  expect(
    ((await result.json()) as ThreadSnapshot).thread.record.interactions['0'],
  ).toEqual({ liked: false, reposted: true, bookmarked: true, replies: [] })
})

test('legacy_conflict_is_atomic_if_post_metadata_arrives_after_snapshot_validation', async () => {
  const { patchOwnedThread } = await import('../../src/server/data/threads')
  const { setPostReaction } =
    await import('../../src/server/data/post-reactions')
  const owned = await create()
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  const before = await env.DB.prepare(
    'SELECT * FROM owned_threads WHERE id = ?',
  )
    .bind(owned.id)
    .first()
  let once = true
  const racing = {
    ...platform,
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: env.DB.batch.bind(env.DB),
    } as D1Database,
  }
  // Detect the write batch by its expected small size, not D1 private fields.
  racing.db.batch = async (statements: D1PreparedStatement[]) => {
    if (once && statements.length < 7) {
      once = false
      await setPostReaction(platform, user, owned.id, owned.posts[0].id, {
        liked: false,
      })
    }
    return env.DB.batch(statements)
  }
  await expect(
    patchOwnedThread(racing, user, owned.id, {
      expectedRevision: 1,
      interactions: owned.record.interactions,
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(once).toBe(false)
  expect(
    await env.DB.prepare('SELECT * FROM owned_threads WHERE id = ?')
      .bind(owned.id)
      .first(),
  ).toEqual(before)
  expect(
    ((await (await call(threadPath(owned))).json()) as ThreadSnapshot).thread
      .record.interactions['0'].liked,
  ).toBe(false)
})

test('progress_rejects_requested_post_deleted_after_validation_even_when_prior_progress_survives', async () => {
  const owned = await create()
  const user = await requireUser(
    new Request(base, { headers: { cookie: alice } }),
    platform,
  )
  await saveReadProgress(platform, user, owned.id, owned.posts[0].id)
  const racing = {
    ...platform,
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.prepare('DELETE FROM owned_posts WHERE id = ?')
          .bind(owned.posts[1].id)
          .run()
        return env.DB.batch(statements)
      },
    } as D1Database,
  }
  await expect(
    saveReadProgress(racing, user, owned.id, owned.posts[1].id),
  ).rejects.toMatchObject({ status: 404 })
  expect(
    ((await (await call(threadPath(owned))).json()) as ThreadSnapshot)
      .readPostId,
  ).toBe(owned.posts[0].id)
})

test('reader_metadata_http_routes_require_session_and_never_cache', async () => {
  vi.mocked(fetch).mockRestore()
  const id = crypto.randomUUID()
  for (const [path, method] of [
    [`/api/comments/${id}/reactions`, 'PATCH'],
    [`/api/threads/${id}/reactions`, 'PATCH'],
    [`/api/threads/${id}/progress`, 'POST'],
  ]) {
    const response = await fetchApp(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  }
})
