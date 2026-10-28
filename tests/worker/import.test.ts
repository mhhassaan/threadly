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
} from '../../src/server/data/api'
import readingMigration from '../../drizzle/migrations/0003_reading.sql?raw'
import importMigration from '../../drizzle/migrations/0004_import.sql?raw'

const base = 'http://127.0.0.1:4176'
let platform: Platform
let messages: { text: string }[]
let background: Promise<unknown>[]
let alice: string
let bob: string
let aliceId: string
type Credentials = { email: string; name: string; password: string }
const people = new Map<string, Credentials>()
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
async function login(existing?: Credentials) {
  const auth = createAuth(platform)
  const person = existing ?? {
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
  if (!existing) {
    expect((await post('sign-up/email')).status).toBe(200)
    await Promise.all(background)
    const link = messages.at(-1)!.text.match(/http[^\s]+/)![0]
    expect((await auth.handler(new Request(link))).status).toBe(302)
  }
  const signedIn = await post('sign-in/email')
  expect(signedIn.status).toBe(200)
  const cookie = signedIn.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ')
  people.set(cookie, person)
  return cookie
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
  if (path.startsWith('/api/threads/'))
    return handleThread(request, platform, path.split('/').at(-1)!)
  return path === '/api/comments'
    ? handleComments(request, platform)
    : handleLibrary(request, platform)
}
const threadPath = (t: OwnedThread) => `/api/threads/${t.id}`
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  await applyMigration(env.DB, readingMigration)
  await applyMigration(env.DB, importMigration)
})
beforeEach(async () => {
  people.clear()
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
// Dropping the migration key or importing replies twice must fail this test.
test('import_resume_deduplicates', async () => {
  const legacy = record(),
    migrationId = crypto.randomUUID()
  const input = { record: legacy, migrationId }
  const first = await call('/api/library', 'POST', input)
  expect(first.status).toBe(201)
  const imported = (await first.json()) as OwnedThread
  const again = await call('/api/library', 'POST', input)
  expect(again.status).toBe(201)
  expect(((await again.json()) as OwnedThread).id).toBe(imported.id)
  expect(imported.id).not.toBe(legacy.id)
  expect(
    ((await (await call('/api/library')).json()) as { threads: OwnedThread[] })
      .threads,
  ).toHaveLength(1)
  const snapshot = (await (
    await call(threadPath(imported))
  ).json()) as ThreadSnapshot
  expect(snapshot.comments).toHaveLength(1)
  expect(snapshot.comments[0]).toMatchObject({
    text: 'Legacy reply',
    createdAt: '2026-10-01',
    authorId: aliceId,
    authorKind: 'human',
    postId: imported.posts[0].id,
  })
  const retry = (await (
    await call(threadPath(imported))
  ).json()) as ThreadSnapshot
  expect(retry.comments[0].id).toBe(snapshot.comments[0].id)
  const otherMigration = await call('/api/library', 'POST', {
    record: legacy,
    migrationId: crypto.randomUUID(),
  })
  expect(((await otherMigration.json()) as OwnedThread).id).toBe(imported.id)
  expect(imported.record.interactions['0'].replies).toEqual([])
  expect(legacy.interactions['0'].replies[0].text).toBe('Legacy reply')
  const bobImport = await call('/api/library', 'POST', input, bob)
  expect(bobImport.status).toBe(201)
  expect(((await bobImport.json()) as OwnedThread).id).not.toBe(imported.id)
})

test('missing_source_stays_missing and two_devices_read_same_thread', async () => {
  const legacy = record()
  delete legacy.sourceText
  const response = await call('/api/library', 'POST', {
    record: legacy,
    migrationId: crypto.randomUUID(),
  })
  expect(response.status).toBe(201)
  const imported = (await response.json()) as OwnedThread
  const deviceOne = (await (
    await call(threadPath(imported))
  ).json()) as ThreadSnapshot
  const secondSession = await login(people.get(alice)!)
  expect(secondSession).not.toBe(alice)
  const deviceTwo = (await (
    await call(threadPath(imported), 'GET', undefined, secondSession)
  ).json()) as ThreadSnapshot
  expect(deviceOne).toEqual(deviceTwo)
  expect(deviceTwo.thread.record).not.toHaveProperty('sourceText')
  expect((await call(threadPath(imported), 'GET', undefined, bob)).status).toBe(
    404,
  )
})

test('import validation leaves no partial thread', async () => {
  const legacy = record()
  legacy.interactions['0'].replies[0].text = ''
  expect(
    (
      await call('/api/library', 'POST', {
        record: legacy,
        migrationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400)
  expect(
    ((await (await call('/api/library')).json()) as { threads: OwnedThread[] })
      .threads,
  ).toEqual([])
})

// A failure after thread/post insertion must roll back the complete import batch.
test('import rollback leaves no thread, posts, comments or resume marker', async () => {
  await env.DB.prepare(
    "CREATE TRIGGER reject_import_test BEFORE INSERT ON comments WHEN NEW.text = 'Reject this test reply' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
  ).run()
  try {
    const legacy = record()
    legacy.interactions['0'].replies[0].text = 'Reject this test reply'
    const response = await call('/api/library', 'POST', {
      record: legacy,
      migrationId: crypto.randomUUID(),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unable to complete request',
    })
    for (const table of [
      'owned_threads',
      'owned_posts',
      'comments',
      'legacy_imports',
    ]) {
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(
          'count',
        ),
      ).toBe(0)
    }
  } finally {
    await env.DB.prepare('DROP TRIGGER reject_import_test').run()
  }
})
