import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createAuth } from '../../src/server/auth/auth'
import { requireUser } from '../../src/server/auth/session'
import * as api from '../../src/server/data/api'
import { applyMigration } from './migrations'
import { getCast } from '../../src/server/discussion/cast'
import { resolveReaderFocus } from '../../src/features/reader/ReaderNavigation'
import type { Platform } from '../../src/server/platform'
import type {
  OwnedThread,
  ThreadSnapshot,
  TurnInput,
  TurnState,
} from '../../src/lib/account-thread'
const base = 'http://localhost:4198'
const migrations = import.meta.glob('../../drizzle/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await applyMigration(env.DB, migrations[path])
})
afterEach(() => vi.restoreAllMocks())

test('verified_x_reader_default_opening_progress_delayed_publication_pause_and_deletion_journey', async () => {
  await env.DB.prepare('DELETE FROM "user"').run()
  await env.DB.prepare('DELETE FROM ai_usage').run()
  await env.DB.prepare('DELETE FROM rate_limit').run()
  const mail: { text: string }[] = [],
    background: Promise<unknown>[] = []
  const platform: Platform = {
    db: env.DB,
    env: {
      authUrl: base,
      authSecret: crypto.randomUUID() + crypto.randomUUID(),
      emailTransport: 'capture',
      dev: true,
      devMailUrl: 'http://localhost:4199',
      resendFrom: '',
      resendApiKey: '',
      deepseekApiKey: 'synthetic-only',
      aiEnabled: true,
      aiDailySpendLimitUsd: 1,
      aiWorstCaseCostMicros: 1000,
    },
    waitUntil(work) {
      background.push(work)
    },
  }
  let pending:
    { thread: OwnedThread; trigger: string | null; memory?: string } | undefined
  let release: (() => void) | undefined,
    entered: (() => void) | undefined,
    delay = false,
    calls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === platform.env.devMailUrl + '/messages') {
      mail.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'capture' })
    }
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    if (!pending) throw Error('Unexpected fake provider call')
    calls++
    const { thread, trigger, memory } = pending,
      speaker = getCast(thread.id)[0].id
    if (delay)
      await new Promise<void>((resolve) => {
        release = resolve
        entered?.()
      })
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              comments: [
                {
                  id: 'a',
                  speakerId: speaker,
                  postId: thread.posts[0].id,
                  parentId: trigger,
                  batchParentId: null,
                  text: 'The synthetic source supports this limited claim.',
                  passageIds: [],
                },
              ],
              memoryUpdates: memory
                ? [{ personaId: speaker, text: memory, evidenceIds: [trigger] }]
                : [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 50 },
    })
  })
  const auth = createAuth(platform)
  const postAuth = (path: string, body: unknown, cookie = '') =>
    auth.handler(
      new Request(base + '/api/auth/' + path, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    )
  const credentials = () => ({
    email: crypto.randomUUID() + '@example.invalid',
    name: 'Synthetic reader',
    password: crypto.randomUUID() + crypto.randomUUID(),
    aiProcessingNoticeVersion: '2026-10-30-v1',
  })
  async function verified(person: ReturnType<typeof credentials>) {
    expect((await postAuth('sign-up/email', person)).status).toBe(200)
    expect((await postAuth('sign-in/email', person)).status).toBe(403)
    await Promise.all(background)
    expect(
      (
        await auth.handler(
          new Request(mail.at(-1)!.text.match(/http[^\s]+/)![0]),
        )
      ).status,
    ).toBe(302)
    const response = await postAuth('sign-in/email', person)
    expect(response.status).toBe(200)
    return response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
  }
  const person = credentials(),
    cookie = await verified(person),
    otherCookie = await verified(credentials())
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    session = cookie,
  ) => {
    const request = new Request(base + path, {
      method,
      headers: {
        origin: base,
        cookie: session,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parts = new URL(request.url).pathname.split('/')
    if (parts[2] === 'auth') return auth.handler(request)
    if (path === '/api/settings') return api.handleSettings(request, platform)
    if (path === '/api/usage') return api.handleUsage(request, platform)
    if (path === '/api/memory') return api.handleMemory(request, platform)
    if (path === '/api/account') return api.handleAccount(request, platform)
    if (path === '/api/comments') return api.handleComments(request, platform)
    if (parts[2] === 'comments')
      return api.handleCommentReactions(request, platform, parts[3])
    if (path === '/api/ai/turns')
      return api.handleAiTurns(request, platform, () => platform)
    if (parts[2] === 'threads' && parts[4] === 'progress')
      return api.handleReadingProgress(request, platform, parts[3])
    if (parts[2] === 'threads' && parts[4] === 'reactions')
      return api.handlePostReactions(request, platform, parts[3])
    if (parts[2] === 'threads')
      return api.handleThread(request, platform, parts[3])
    return api.handleLibrary(request, platform)
  }
  const settings = await call('/api/settings')
  expect(settings.headers.get('cache-control')).toBe('private, no-store')
  expect(await settings.json()).toMatchObject({
    aiEnabled: true,
    memoryEnabled: false,
    consentAt: expect.any(String),
  })
  const record = () => ({
    id: crypto.randomUUID(),
    title: 'Synthetic solar reading',
    sourceText: 'Solar panels produce power. Storage has costs.',
    posts: [
      'Solar panels produce power.',
      'Storage has costs.',
      'Evidence has limits.',
    ],
    sourceUrl: '',
    source: null,
    media: [],
    interactions: {},
  })
  const created = await call('/api/library', 'POST', { record: record() })
  expect(created.status).toBe(201)
  const thread = (await created.json()) as OwnedThread,
    path = '/api/threads/' + thread.id
  const snapshot = async (session = cookie) =>
    (await (
      await call(path, 'GET', undefined, session)
    ).json()) as ThreadSnapshot
  const owner = await requireUser(
    new Request(base, { headers: { cookie } }),
    platform,
  )
  expect(thread.ownerId).toBe(owner.userId)
  const opening: TurnInput = {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'opening',
    triggerCommentId: null,
  }
  pending = { thread, trigger: null }
  const opened = (await (
    await call('/api/ai/turns', 'POST', opening)
  ).json()) as TurnState
  expect(opened.status).toBe('complete')
  expect(opened.commentIds).toHaveLength(1)
  const first = await snapshot(),
    commentId = first.comments[0].id
  expect(
    resolveReaderFocus(
      { post: thread.posts[0].id, comment: commentId },
      thread.record,
      first,
      owner.userId,
    ),
  ).toEqual({ postId: thread.posts[0].id, commentId, index: 0 })
  for (let i = 0; i < 3; i++) await snapshot()
  expect(
    ((await (await call('/api/ai/turns', 'POST', opening)).json()) as TurnState)
      .id,
  ).toBe(opened.id)
  expect(calls).toBe(1)
  expect(
    (
      await call('/api/comments/' + commentId + '/reactions', 'PATCH', {
        liked: true,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await call(path + '/reactions', 'PATCH', {
        postId: thread.posts[0].id,
        bookmarked: true,
      })
    ).status,
  ).toBe(200)
  expect((await snapshot()).commentReactions?.[commentId].liked).toBe(true)
  // Existing/imported reads have no creation intent and no provider work.
  const imported = (await (
    await call('/api/library', 'POST', {
      record: record(),
      migrationId: crypto.randomUUID(),
    })
  ).json()) as OwnedThread
  expect(
    (
      (await (
        await call('/api/threads/' + imported.id)
      ).json()) as ThreadSnapshot
    ).isImported,
  ).toBe(true)
  expect(calls).toBe(1)
  expect(
    (await call('/api/settings', 'PATCH', { memoryEnabled: true })).status,
  ).toBe(200)
  const human = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    postId: thread.posts[0].id,
    parentId: commentId,
    text: 'I prefer solar storage evidence.',
  }
  expect((await call('/api/comments', 'POST', human)).status).toBe(201)
  const reply: TurnInput = {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'reply',
    triggerCommentId: human.id,
  }
  pending = { thread, trigger: human.id, memory: human.text }
  delay = true
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const working = call('/api/ai/turns', 'POST', reply)
  await started
  const protectedTables = [
    'owned_threads',
    'owned_posts',
    'source_passages',
    'memory_evidence',
  ]
  const protectedRows = async () =>
    (
      await env.DB.batch(
        protectedTables.map((table) =>
          env.DB.prepare('SELECT * FROM ' + table),
        ),
      )
    ).map((result) => result.results)
  const before = await protectedRows()
  expect(
    (await call(path + '/progress', 'POST', { postId: thread.posts[1].id }))
      .status,
  ).toBe(200)
  expect(
    (await call(path + '/progress', 'POST', { postId: thread.posts[0].id }))
      .status,
  ).toBe(200)
  expect(
    (
      await call(path + '/reactions', 'PATCH', {
        postId: thread.posts[1].id,
        reposted: true,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await call('/api/comments/' + human.id + '/reactions', 'PATCH', {
        bookmarked: true,
      })
    ).status,
  ).toBe(200)
  expect(await protectedRows()).toEqual(before)
  expect((await snapshot()).readPostId).toBe(thread.posts[1].id)
  release!()
  const complete = (await (await working).json()) as TurnState
  expect(complete.status).toBe('complete')
  expect(complete.commentIds).toHaveLength(1)
  expect(
    (await snapshot()).comments.find(
      (comment) => comment.id === complete.commentIds[0],
    )?.parentId,
  ).toBe(human.id)
  const memories = (await (await call('/api/memory')).json()) as any[]
  expect(memories).toMatchObject([{ text: human.text }])
  const memoryBefore = await env.DB.prepare(
    'SELECT * FROM memory_evidence',
  ).all()
  const contentBefore = (await snapshot()).thread
  expect(
    (await call(path + '/progress', 'POST', { postId: thread.posts[2].id }))
      .status,
  ).toBe(200)
  expect((await snapshot()).thread).toEqual(contentBefore)
  expect(
    (await env.DB.prepare('SELECT * FROM memory_evidence').all()).results,
  ).toEqual(memoryBefore.results)
  expect(await (await call('/api/memory')).json()).toEqual(memories)
  expect(
    (await call('/api/settings', 'PATCH', { aiEnabled: false })).status,
  ).toBe(200)
  const paused = {
    ...human,
    id: crypto.randomUUID(),
    text: 'A manual comment while paused.',
  }
  expect((await call('/api/comments', 'POST', paused)).status).toBe(201)
  expect(
    (
      await call('/api/ai/turns', 'POST', {
        ...reply,
        requestId: crypto.randomUUID(),
        triggerCommentId: paused.id,
      })
    ).status,
  ).toBe(403)
  await snapshot()
  expect(calls).toBe(2)
  for (const suffix of ['', '/progress', '/reactions']) {
    const method =
      suffix === '/progress'
        ? 'POST'
        : suffix === '/reactions'
          ? 'PATCH'
          : 'GET'
    const body = suffix
      ? {
          postId: thread.posts[0].id,
          ...(suffix === '/reactions' ? { liked: true } : {}),
        }
      : undefined
    expect((await call(path + suffix, method, body, otherCookie)).status).toBe(
      404,
    )
  }
  const source = (await snapshot()).thread.record.sourceText
  expect(
    (
      await call('/api/comments', 'DELETE', {
        threadId: thread.id,
        postId: thread.posts[0].id,
      })
    ).status,
  ).toBe(204)
  expect((await snapshot()).comments).toEqual([])
  expect((await snapshot()).thread.record.sourceText).toBe(source)
  expect((await snapshot()).openingBlocked).toBe(true)
  expect(await (await call('/api/memory')).json()).toEqual([])
  expect((await call(path, 'DELETE', {}, otherCookie)).status).toBe(404)
  expect((await call(path, 'DELETE', {})).status).toBe(204)
  expect(
    (await call(path + '/progress', 'POST', { postId: thread.posts[2].id }))
      .status,
  ).toBe(404)
  expect(
    (await call('/api/account', 'DELETE', { password: person.password }))
      .status,
  ).toBe(204)
  expect((await call('/api/library')).status).toBe(401)
  expect(
    (await call('/api/library', 'GET', undefined, otherCookie)).status,
  ).toBe(200)
  expect(
    await env.DB.prepare('SELECT id FROM owned_threads WHERE owner_id=?')
      .bind(owner.userId)
      .all(),
  ).toMatchObject({ results: [] })
  expect(calls).toBe(2)
})
