import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createAuth } from '../../src/server/auth/auth'
import { requireUser } from '../../src/server/auth/session'
import * as api from '../../src/server/data/api'
import { applyMigration } from './migrations'
import { getCast } from '../../src/server/discussion/cast'
import type { Platform } from '../../src/server/platform'
import type {
  OwnedThread,
  ThreadSnapshot,
  TurnInput,
  TurnState,
} from '../../src/lib/account-thread'

const base = 'http://localhost:4194'
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

test('two authenticated devices retain private source, edits, bounded discussion, memory and recovery', async () => {
  await env.DB.prepare('DELETE FROM "user"').run()
  await env.DB.prepare('DELETE FROM ai_usage').run()
  await env.DB.prepare('DELETE FROM rate_limit').run()
  const mail: { text: string }[] = []
  const background: Promise<unknown>[] = []
  const platform: Platform = {
    db: env.DB,
    env: {
      authUrl: base,
      authSecret: crypto.randomUUID() + crypto.randomUUID(),
      emailTransport: 'capture',
      dev: true,
      devMailUrl: 'http://127.0.0.1:4187',
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
    | { thread: OwnedThread; trigger: string | null; remember?: string }
    | undefined
  const providerContexts: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === platform.env.devMailUrl + '/messages') {
      mail.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'capture' })
    }
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    if (!pending) throw Error('Unexpected provider request')
    const content = JSON.parse(String(init?.body))
    providerContexts.push(JSON.stringify(content.messages))
    const { thread, trigger, remember } = pending
    const speaker = getCast(thread.id)[0].id
    const comments = [
      {
        id: 'a',
        speakerId: speaker,
        postId: thread.posts[0].id,
        parentId: trigger,
        batchParentId: null,
        text: 'The source supports a limited claim.',
        passageIds: [],
      },
    ]
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              comments,
              memoryUpdates: remember
                ? [
                    {
                      personaId: speaker,
                      text: remember,
                      evidenceIds: [trigger],
                    },
                  ]
                : [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 50 },
    })
  })
  const auth = createAuth(platform)
  const jar = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ')
  const postAuth = (path: string, body: unknown, cookie = '') =>
    auth.handler(
      new Request(`${base}/api/auth/${path}`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    )
  const person = {
    email: `${crypto.randomUUID()}@example.invalid`,
    name: 'Synthetic reader',
    password: crypto.randomUUID() + crypto.randomUUID(),
  }
  expect((await postAuth('sign-up/email', person)).status).toBe(200)
  expect((await postAuth('sign-in/email', person)).status).toBe(403)
  await Promise.all(background)
  expect(
    (await auth.handler(new Request(mail.at(-1)!.text.match(/http[^\s]+/)![0])))
      .status,
  ).toBe(302)
  const deviceA = jar(await postAuth('sign-in/email', person))
  const deviceB = jar(await postAuth('sign-in/email', person))
  expect(deviceA).not.toBe(deviceB)
  const otherPerson = {
    ...person,
    email: `${crypto.randomUUID()}@example.invalid`,
  }
  expect((await postAuth('sign-up/email', otherPerson)).status).toBe(200)
  await Promise.all(background)
  expect(
    (await auth.handler(new Request(mail.at(-1)!.text.match(/http[^\s]+/)![0])))
      .status,
  ).toBe(302)
  const otherOwner = jar(await postAuth('sign-in/email', otherPerson))
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = deviceA,
    origin = base,
  ) => {
    const request = new Request(base + path, {
      method,
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (path === '/api/usage') return api.handleUsage(request, platform)
    if (path === '/api/settings') return api.handleSettings(request, platform)
    if (path.startsWith('/api/memory'))
      return api.handleMemory(request, platform)
    if (path === '/api/comments') return api.handleComments(request, platform)
    if (path.startsWith('/api/ai/turns/'))
      return api.handleAiTurn(request, platform, path.split('/').at(-1)!)
    if (path === '/api/ai/turns')
      return api.handleAiTurns(request, platform, () => platform)
    if (path.startsWith('/api/threads/'))
      return api.handleThread(request, platform, path.split('/').at(-1)!)
    return api.handleLibrary(request, platform)
  }
  // No import occurs on login; only the explicit migration request uploads the guest record.
  expect(await (await call('/api/library')).json()).toMatchObject({
    threads: [],
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
  const legacy = record()
  const importBody = { migrationId: crypto.randomUUID(), record: legacy }
  const imported = (await (
    await call('/api/library', 'POST', importBody)
  ).json()) as OwnedThread
  expect(
    (
      (await (
        await call('/api/library', 'POST', importBody)
      ).json()) as OwnedThread
    ).id,
  ).toBe(imported.id)
  expect(imported.id).not.toBe(legacy.id)
  const created = await call('/api/library', 'POST', { record: record() })
  expect(created.status).toBe(201)
  let thread = (await created.json()) as OwnedThread
  const owner = await requireUser(
    new Request(base, { headers: { cookie: deviceA } }),
    platform,
  )
  expect(thread.ownerId).toBe(owner.userId)
  const initialUsage = await call('/api/usage')
  expect(initialUsage.headers.get('cache-control')).toBe('private, no-store')
  expect(await initialUsage.json()).toMatchObject({
    opening: { remaining: 5, limit: 5 },
    reply: { remaining: 30, limit: 30 },
  })
  expect((await call('/api/usage', 'GET', undefined, '')).status).toBe(401)
  expect((await call('/api/usage', 'POST', {})).status).toBe(405)
  expect((await call('/api/usage?ownerId=' + owner.userId)).status).toBe(400)
  expect(
    (
      await call('/api/settings', 'PATCH', {
        aiEnabled: true,
        memoryEnabled: true,
        acknowledgeConsent: true,
      })
    ).status,
  ).toBe(200)
  const opening: TurnInput = {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'opening',
    triggerCommentId: null,
  }
  pending = { thread, trigger: null }
  expect((await call('/api/ai/turns', 'POST', opening, '', base)).status).toBe(
    401,
  )
  expect(
    (await call('/api/ai/turns', 'POST', opening, otherOwner)).status,
  ).toBe(404)
  expect(
    (
      await call(
        '/api/ai/turns',
        'POST',
        opening,
        deviceA,
        'https://evil.invalid',
      )
    ).status,
  ).toBe(403)
  const opened = await call('/api/ai/turns', 'POST', opening)
  expect(opened.headers.get('cache-control')).toBe('private, no-store')
  expect(((await opened.json()) as TurnState).status).toBe('complete')
  const snapshot = async () =>
    (await (
      await call(`/api/threads/${thread.id}`, 'GET', undefined, deviceB)
    ).json()) as ThreadSnapshot
  expect((await snapshot()).comments).toHaveLength(1)
  expect(
    new Set((await snapshot()).comments.map((c) => c.postId)).size,
  ).toBeLessThan(thread.posts.length)
  const edit = await call(
    `/api/threads/${thread.id}`,
    'PATCH',
    {
      expectedRevision: thread.revision,
      posts: [{ id: thread.posts[0].id, text: 'Edited solar reading.' }],
    },
    deviceB,
  )
  expect(edit.status).toBe(200)
  thread = ((await edit.json()) as ThreadSnapshot).thread
  expect((await snapshot()).thread.record.sourceText).toBe(legacy.sourceText)
  const quote = 'I prefer solar storage evidence.'
  const humanId = crypto.randomUUID()
  expect(
    (
      await call('/api/comments', 'POST', {
        id: humanId,
        threadId: thread.id,
        postId: thread.posts[0].id,
        parentId: null,
        text: quote,
      })
    ).status,
  ).toBe(201)
  pending = { thread, trigger: humanId, remember: quote }
  const reply: TurnInput = {
    requestId: crypto.randomUUID(),
    threadId: thread.id,
    kind: 'reply',
    triggerCommentId: humanId,
  }
  const completed = (await (
    await call('/api/ai/turns', 'POST', reply)
  ).json()) as TurnState
  expect(completed.status).toBe('complete')
  expect(completed.commentIds.length).toBeGreaterThan(0)
  expect(completed.commentIds.length).toBeLessThanOrEqual(3)
  const count = providerContexts.length
  const status = await call(`/api/ai/turns/${completed.id}`)
  expect(status.headers.get('cache-control')).toBe('private, no-store')
  expect(((await status.json()) as TurnState).status).toBe('complete')
  expect(providerContexts).toHaveLength(count)
  for (const method of ['GET', 'DELETE']) {
    const input = method === 'DELETE' ? {} : undefined
    const denied = await call(
      `/api/ai/turns/${completed.id}`,
      method,
      input,
      otherOwner,
    )
    expect(denied.status).toBe(404)
    expect(denied.headers.get('cache-control')).toBe('private, no-store')
    expect(
      (await call(`/api/ai/turns/${completed.id}`, method, input, '')).status,
    ).toBe(401)
  }
  expect(
    (
      await call(
        `/api/ai/turns/${completed.id}`,
        'DELETE',
        {},
        deviceA,
        'https://evil.invalid',
      )
    ).status,
  ).toBe(403)
  expect(
    (await call(`/api/ai/turns/${completed.id}`, 'DELETE', {})).headers.get(
      'cache-control',
    ),
  ).toBe('private, no-store')
  expect(await (await call('/api/memory')).json()).toMatchObject([
    { text: quote },
  ])
  thread = (await (
    await call('/api/library', 'POST', { record: record() })
  ).json()) as OwnedThread
  pending = { thread, trigger: null }
  expect(
    (
      (await (
        await call('/api/ai/turns', 'POST', {
          ...opening,
          requestId: crypto.randomUUID(),
          threadId: thread.id,
        })
      ).json()) as TurnState
    ).status,
  ).toBe('complete')
  expect(providerContexts.at(-1)).toContain(quote)
  expect((await call('/api/memory', 'DELETE', {})).status).toBe(204)
  expect(await (await call('/api/memory')).json()).toEqual([])
  expect(await (await call('/api/usage')).json()).toMatchObject({
    opening: { remaining: 3 },
    reply: { remaining: 29 },
  })
  expect(
    await (await call('/api/usage', 'GET', undefined, otherOwner)).json(),
  ).toMatchObject({ opening: { remaining: 5 }, reply: { remaining: 30 } })
  // Operator exhaustion leaves reading and manual commenting available.
  platform.env.aiDailySpendLimitUsd = 0.001
  const unavailable = (await (await call('/api/usage')).json()) as Record<
    string,
    unknown
  >
  expect(unavailable.availability).toBe('unavailable')
  expect(Object.keys(unavailable).sort()).toEqual([
    'availability',
    'opening',
    'reply',
    'utcDay',
  ])
  const manual = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    postId: thread.posts[0].id,
    parentId: null,
    text: 'Still reading and commenting.',
  }
  expect((await call('/api/comments', 'POST', manual)).status).toBe(201)
  expect((await snapshot()).comments.map((c) => c.text)).toContain(manual.text)
  expect(
    await (
      await call('/api/ai/turns', 'POST', {
        ...reply,
        requestId: crypto.randomUUID(),
        threadId: thread.id,
        triggerCommentId: manual.id,
      })
    ).json(),
  ).toMatchObject({ code: 'AI_LIMIT_REACHED' })
  expect((await call(`/api/threads/${thread.id}`, 'DELETE', {})).status).toBe(
    204,
  )
  expect((await call(`/api/threads/${thread.id}`)).status).toBe(404)
  expect(
    (
      await postAuth('request-password-reset', {
        email: person.email,
        redirectTo: base + '/account/reset',
      })
    ).status,
  ).toBe(200)
  await Promise.all(background)
  const reset = await auth.handler(
    new Request(mail.at(-1)!.text.match(/http[^\s]+/)![0]),
  )
  const token = new URL(reset.headers.get('location')!).searchParams.get(
    'token',
  )
  person.password = crypto.randomUUID() + crypto.randomUUID()
  expect(
    (await postAuth('reset-password', { token, newPassword: person.password }))
      .status,
  ).toBe(200)
  for (const cookie of [deviceA, deviceB])
    expect((await call('/api/library', 'GET', undefined, cookie)).status).toBe(
      401,
    )
  const recovered = jar(await postAuth('sign-in/email', person))
  expect((await call('/api/library', 'GET', undefined, recovered)).status).toBe(
    200,
  )
  expect((await postAuth('sign-out', {}, recovered)).status).toBe(200)
  expect((await call('/api/library', 'GET', undefined, recovered)).status).toBe(
    401,
  )
})
