import privacyMigration from '../../drizzle/migrations/0010_privacy.sql?raw'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import imports from '../../drizzle/migrations/0004_import.sql?raw'
import discussion from '../../drizzle/migrations/0005_discussion.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
import discussionUi from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
import memoryMigration from '../../drizzle/migrations/0009_memory.sql?raw'
import {
  getRelevantMemories,
  inspectMemories,
} from '../../src/server/discussion/memory'
import openingAdmissions from '../../drizzle/migrations/0008_opening_admissions.sql?raw'
import {
  saveThread,
  getSnapshot,
  patchOwnedThread,
} from '../../src/server/data/threads'
import { appendHumanComment } from '../../src/server/data/comments'
import { updateSettings } from '../../src/server/data/settings'
import { runTurn } from '../../src/server/discussion/generate'
import { getCast } from '../../src/server/discussion/cast'
import { cancelTurn, getTurn } from '../../src/server/discussion/turns'
import type { Platform } from '../../src/server/platform'
const user = {
  userId: 'alice',
  name: 'Alice',
  email: 'a@example.invalid',
  verified: true,
}
const platform = {
  db: env.DB,
  env: {
    authUrl: 'http://localhost',
    authSecret: '',
    emailTransport: 'capture',
    dev: true,
    devMailUrl: '',
    resendFrom: '',
    resendApiKey: '',
    deepseekApiKey: 'test',
    aiEnabled: true,
    aiDailySpendLimitUsd: 100,
    aiWorstCaseCostMicros: 1000,
  },
  waitUntil() {},
} as Platform
let input: {
  requestId: string
  threadId: string
  kind: 'reply'
  triggerCommentId: string
}
let post: string
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  await applyMigration(env.DB, reading)
  await applyMigration(env.DB, imports)
  await applyMigration(env.DB, discussion)
  await applyMigration(env.DB, turns)
  await applyMigration(env.DB, discussionUi)
  await applyMigration(env.DB, openingAdmissions)
  await applyMigration(env.DB, memoryMigration)
  await applyMigration(env.DB, privacyMigration)
})
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM ai_usage').run()
  await env.DB.prepare('DELETE FROM "user"').run()
  await env.DB.prepare(
    'INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind('alice', 'Alice', 'a@example.invalid')
    .run()
  await updateSettings(platform, user, {
    aiEnabled: true,
    acknowledgeConsent: true,
  })
  const id = crypto.randomUUID()
  const thread = await saveThread(
    platform,
    user,
    {
      id,
      title: 'Title',
      sourceText: 'Evidence',
      posts: ['First', 'Second'],
      sourceUrl: '',
      source: null,
      media: [],
      interactions: {},
    },
    null,
  )
  post = thread.posts[0].id
  const commentId = crypto.randomUUID()
  await appendHumanComment(platform, user, {
    id: commentId,
    threadId: id,
    postId: post,
    parentId: null,
    text: 'Correction: solar storage costs remain uncertain.',
  })
  input = {
    requestId: crypto.randomUUID(),
    threadId: id,
    kind: 'reply',
    triggerCommentId: commentId,
  }
})
afterEach(() => vi.unstubAllGlobals())
function response() {
  return Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            memoryUpdates: [],
            comments: [
              {
                id: 'a',
                speakerId: getCast(input.threadId)[0].id,
                postId: post,
                parentId: input.triggerCommentId,
                batchParentId: null,
                text: 'Reply',
                passageIds: [],
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  })
}

const regular = getCast('20000000-0000-4000-8000-000000000001')[0].id
const quote = 'Correction: solar storage costs remain uncertain.'
async function remember() {
  await updateSettings(platform, user, { memoryEnabled: true })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const payload = (await response().json()) as any
      const exchange = JSON.parse(payload.choices[0].message.content)
      exchange.memoryUpdates = [
        {
          personaId: regular,
          text: quote,
          evidenceIds: [input.triggerCommentId],
        },
      ]
      payload.choices[0].message.content = JSON.stringify(exchange)
      return Response.json(payload)
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
}
const retrieve = (personaIds = [regular], owner = user) =>
  getRelevantMemories(platform, owner, {
    personaIds,
    text: 'solar storage costs',
    limit: 4,
  })

import * as privacy from '../../src/server/data/privacy'
test('memory_clear_not_rebuilt_from_old_history', async () => {
  await remember()
  await privacy.clearMemory(platform, user)
  expect((await retrieve()).length).toBe(0)
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments.length,
  ).toBeGreaterThan(0)
  input.requestId = crypto.randomUUID()
  await runTurn(platform, user, input, new AbortController().signal)
  expect(await retrieve()).toEqual([])
  await expect(
    (await import('../../src/server/data/settings')).getSettings(
      platform,
      user,
    ),
  ).resolves.toMatchObject({ memoryEpoch: 1 })
})
test('conversation_delete_cleans_evidence', async () => {
  await remember()
  await privacy.deleteConversation(platform, user, input.threadId, post)
  expect((await getSnapshot(platform, user, input.threadId)).comments).toEqual(
    [],
  )
  expect(
    await env.DB.prepare('SELECT * FROM participant_memories WHERE owner_id=?')
      .bind(user.userId)
      .all(),
  ).toMatchObject({ results: [] })
  expect(
    (await getSnapshot(platform, user, input.threadId)).thread.posts.length,
  ).toBe(2)
  await expect(
    runTurn(
      platform,
      user,
      {
        requestId: crypto.randomUUID(),
        threadId: input.threadId,
        kind: 'opening',
        triggerCommentId: null,
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'DISCUSSION_DELETED' })
})
test('ai_pause_cancels_pending', async () => {
  let deliver!: () => void
  const waiting = new Promise<void>((resolve) => {
    deliver = resolve
  })
  let reached!: () => void
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reached()
      await waiting
      return response()
    }),
  )
  const pending = runTurn(platform, user, input, new AbortController().signal)
  await started
  await updateSettings(platform, user, { aiEnabled: false })
  deliver()
  expect((await pending).status).toBe('cancelled')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})

import {
  handleAccount,
  handleMemory,
  handleComments,
  handleThread,
} from '../../src/server/data/api'
import { createAuth } from '../../src/server/auth/auth'
import { hashPassword } from 'better-auth/crypto'
async function authenticated() {
  const password = crypto.randomUUID() + crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (?, ?, 'credential', ?, ?,1,1)`,
  )
    .bind(
      crypto.randomUUID(),
      user.userId,
      user.userId,
      await hashPassword(password),
    )
    .run()
  const result = await createAuth(platform).handler(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: user.email, password }),
    }),
  )
  expect(result.status).toBe(200)
  const cookie = result.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ')
  return { password, cookie }
}
function apiRequest(
  path: string,
  cookie: string,
  input: unknown = {},
  method = 'DELETE',
) {
  return new Request('http://localhost' + path, {
    method,
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      cookie,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
  })
}
test('account_delete_removes_owned_rows_sessions', async () => {
  await remember()
  const { password, cookie } = await authenticated()
  await env.DB.prepare(
    `INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('bob','Bob','b@example.invalid',1,1,1)`,
  ).run()
  await env.DB.prepare(
    `INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES ('a-reset','reset-password:a','alice',9999999999999,1,1),('b-reset','reset-password:b','bob',9999999999999,1,1)`,
  ).run()
  expect(
    (
      await handleAccount(
        apiRequest('/api/account', cookie, { password: 'wrong' }),
        platform,
      )
    ).status,
  ).toBe(403)
  expect(
    (await handleAccount(apiRequest('/api/account', cookie, {}), platform))
      .status,
  ).toBe(400)
  expect(
    (
      await handleAccount(
        apiRequest('/api/account', cookie, { password }),
        platform,
      )
    ).status,
  ).toBe(204)
  for (const table of [
    'owned_threads',
    'comments',
    'account_settings',
    'participant_memories',
    'memory_resets',
    'memory_suppressions',
    'ai_requests',
    'ai_turns',
    'legacy_imports',
  ])
    expect(
      (
        await env.DB.prepare(
          `SELECT count(*) AS n FROM ${table} WHERE owner_id=?`,
        )
          .bind(user.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0)
  for (const table of ['session', 'account'])
    expect(
      (
        await env.DB.prepare(
          `SELECT count(*) AS n FROM ${table} WHERE user_id=?`,
        )
          .bind(user.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0)
  expect(
    await env.DB.prepare(`SELECT id FROM user WHERE id='bob'`).first(),
  ).toBeTruthy()
  expect(
    await env.DB.prepare(
      `SELECT id FROM verification WHERE id='a-reset'`,
    ).first(),
  ).toBeNull()
  expect(
    await env.DB.prepare(
      `SELECT id FROM verification WHERE id='b-reset'`,
    ).first(),
  ).toBeTruthy()
  expect(
    await env.DB.prepare('SELECT owner_id FROM ai_usage').first(),
  ).toMatchObject({ owner_id: null })
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM rate_limit WHERE key LIKE 'account-delete:alice:%'",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(0)
  expect(
    (await handleMemory(apiRequest('/api/memory', cookie, {}, 'GET'), platform))
      .status,
  ).toBe(401)
})
test('item_delete_suppresses_old_evidence_and_owner_management_works_paused', async () => {
  await remember()
  const { cookie } = await authenticated()
  const item = (await retrieve())[0]
  await updateSettings(platform, user, { memoryEnabled: false })
  expect(await retrieve()).toEqual([])
  const list = await handleMemory(
    apiRequest('/api/memory', cookie, {}, 'GET'),
    platform,
  )
  expect(list.headers.get('cache-control')).toBe('private, no-store')
  expect(((await list.json()) as any[]).map((x) => x.id)).toContain(item.id)
  expect(
    (
      await handleMemory(
        apiRequest('/api/memory', cookie, { ownerId: 'bob' }),
        platform,
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await handleMemory(
        apiRequest('/api/memory', cookie, { id: item.id }),
        platform,
      )
    ).status,
  ).toBe(204)
  await updateSettings(platform, user, { memoryEnabled: true })
  input.requestId = crypto.randomUUID()
  await runTurn(platform, user, input, new AbortController().signal)
  expect(await retrieve()).toEqual([])
})
test('per_persona_reset_preserves_other_regular_and_used_refs', async () => {
  await remember()
  const other = getCast(input.threadId)[1].id,
    id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO participant_memories(id,owner_id,persona_id,text,evidence_ids,epoch,created_at,turn_id) VALUES (?,?,?,?,?,0,?,?)',
  )
    .bind(
      id,
      user.userId,
      other,
      quote,
      JSON.stringify([input.triggerCommentId]),
      new Date().toISOString(),
      'fixture',
    )
    .run()
  const snapshot = await getSnapshot(platform, user, input.threadId)
  await env.DB.prepare(
    'INSERT INTO memory_evidence(memory_id,comment_id,thread_revision,source_revision) VALUES (?,?,?,?)',
  )
    .bind(
      id,
      input.triggerCommentId,
      snapshot.thread.revision,
      snapshot.thread.sourceRevision,
    )
    .run()
  await privacy.clearMemory(platform, user, regular)
  expect(await retrieve()).toEqual([])
  expect(await retrieve([other])).toMatchObject([{ id, epoch: 1 }])
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments.length,
  ).toBeGreaterThan(0)
  input.requestId = crypto.randomUUID()
  await runTurn(platform, user, input, new AbortController().signal)
  expect(await retrieve()).toEqual([])
})
test('memory_reset_during_provider_flight_fences_result', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
  let deliver!: () => void, reached!: () => void
  const ready = new Promise<void>((r) => {
      reached = r
    }),
    waiting = new Promise<void>((r) => {
      deliver = r
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reached()
      await waiting
      return response()
    }),
  )
  const pending = runTurn(platform, user, input, new AbortController().signal)
  await ready
  await privacy.clearMemory(platform, user)
  deliver()
  expect((await pending).status).toBe('cancelled')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('account_delete_rechecks_reset_and_revoked_session_at_atomic_boundary', async () => {
  const { cookie, password } = await authenticated()
  for (const reset of [false, true]) {
    const racing = {
      ...platform,
      db: new Proxy(platform.db, {
        get(target, key) {
          if (key !== 'prepare') {
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.startsWith('DELETE FROM user WHERE')) return statement
            return {
              bind(...values: any[]) {
                const bound = statement.bind(...values)
                return {
                  async run() {
                    if (reset)
                      await target
                        .prepare(
                          'UPDATE account SET password=? WHERE user_id=?',
                        )
                        .bind(
                          await hashPassword(crypto.randomUUID()),
                          user.userId,
                        )
                        .run()
                    else
                      await target
                        .prepare('DELETE FROM session WHERE user_id=?')
                        .bind(user.userId)
                        .run()
                    return bound.run()
                  },
                }
              },
            }
          }
        },
      }),
    } as Platform
    if (reset) {
      // Recover the disposable session only; keep the same credential.
      const login = await createAuth(platform).handler(
        new Request('http://localhost/api/auth/sign-in/email', {
          method: 'POST',
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: user.email, password }),
        }),
      )
      const second = login.headers
        .getSetCookie()
        .map((x) => x.split(';')[0])
        .join('; ')
      expect(
        (
          await handleAccount(
            apiRequest('/api/account', second, { password }),
            racing,
          )
        ).status,
      ).toBe(409)
    } else
      expect(
        (
          await handleAccount(
            apiRequest('/api/account', cookie, { password }),
            racing,
          )
        ).status,
      ).toBe(409)
    expect(
      await env.DB.prepare('SELECT id FROM user WHERE id=?')
        .bind(user.userId)
        .first(),
    ).toBeTruthy()
  }
})
test('public_auth_delete_endpoint_cannot_bypass_password_confirmation', async () => {
  const { cookie } = await authenticated()
  const response = await createAuth(platform).handler(
    apiRequest('/api/auth/delete-user', cookie, {}, 'POST'),
  )
  expect(response.ok).toBe(false)
  expect(
    await env.DB.prepare('SELECT id FROM user WHERE id=?')
      .bind(user.userId)
      .first(),
  ).toBeTruthy()
})

test('deleted_account_cannot_regain_reset_verification_from_late_request', async () => {
  const { cookie, password } = await authenticated()
  expect(
    (
      await handleAccount(
        apiRequest('/api/account', cookie, { password }),
        platform,
      )
    ).status,
  ).toBe(204)
  await expect(
    env.DB.prepare(
      "INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES ('late-reset','reset-password:late','alice',9999999999999,1,1)",
    ).run(),
  ).rejects.toThrow()
  expect(
    await env.DB.prepare(
      "SELECT id FROM verification WHERE id='late-reset'",
    ).first(),
  ).toBeNull()
})

test('deleted_conversation_requires_explicit_restart_without_automatic_generation', async () => {
  await remember()
  await privacy.deleteConversation(platform, user, input.threadId, post)
  const before = await env.DB.prepare(
    'SELECT count(*) n FROM ai_turns WHERE owner_id=?',
  )
    .bind(user.userId)
    .first<{ n: number }>()
  await privacy.restartDiscussion(platform, user, input.threadId)
  expect(
    await env.DB.prepare('SELECT count(*) n FROM ai_turns WHERE owner_id=?')
      .bind(user.userId)
      .first(),
  ).toEqual(before)
  const { reserveTurn } = await import('../../src/server/discussion/turns')
  expect(
    (
      await reserveTurn(platform, user, {
        requestId: crypto.randomUUID(),
        threadId: input.threadId,
        kind: 'opening',
        triggerCommentId: null,
      })
    ).status,
  ).toBe('reserved')
})
test('conversation_delete_validates_post_owner_and_cleans_surviving_used_refs', async () => {
  await remember()
  const snapshot = await getSnapshot(platform, user, input.threadId),
    second = snapshot.thread.posts[1]
  const memory = (await retrieve())[0]
  await env.DB.prepare(
    "INSERT INTO comments(id,thread_id,post_id,owner_id,author_kind,author_id,text,sequence,created_at,used_memory_ids) VALUES (?,?,?,?, 'ai',?,'Synthetic reply',3,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      input.threadId,
      second.id,
      user.userId,
      regular,
      new Date().toISOString(),
      JSON.stringify([memory.id]),
    )
    .run()
  const { cookie } = await authenticated()
  expect(
    (
      await handleComments(
        apiRequest('/api/comments', cookie, {
          threadId: input.threadId,
          postId: crypto.randomUUID(),
        }),
        platform,
      )
    ).status,
  ).toBe(404)
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(3)
  expect(
    (
      await handleComments(
        apiRequest('/api/comments', cookie, {
          threadId: input.threadId,
          postId: post,
          ownerId: 'bob',
        }),
        platform,
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await handleComments(
        apiRequest('/api/comments', cookie, {
          threadId: input.threadId,
          postId: post,
        }),
        platform,
      )
    ).status,
  ).toBe(204)
  const remaining = (await getSnapshot(platform, user, input.threadId)).comments
  expect(remaining).toHaveLength(1)
  expect(remaining[0].usedMemoryIds).toEqual([])
  expect(
    await env.DB.prepare('SELECT * FROM memory_evidence').all(),
  ).toMatchObject({ results: [] })
  expect(
    (
      await handleThread(
        apiRequest('/api/threads/' + input.threadId, cookie),
        platform,
        input.threadId,
      )
    ).status,
  ).toBe(204)
  expect(await env.DB.prepare('SELECT * FROM owned_posts').all()).toMatchObject(
    { results: [] },
  )
})
test('memory_pause_during_provider_flight_cancels_without_stopping_history', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
  let reached!: () => void, deliver!: () => void
  const ready = new Promise<void>((r) => {
      reached = r
    }),
    waiting = new Promise<void>((r) => {
      deliver = r
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reached()
      await waiting
      return response()
    }),
  )
  const pending = runTurn(platform, user, input, new AbortController().signal)
  await ready
  await updateSettings(platform, user, { memoryEnabled: false })
  deliver()
  expect((await pending).status).toBe('cancelled')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
  await appendHumanComment(platform, user, {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    postId: post,
    parentId: null,
    text: 'History still syncs while memory is paused.',
  })
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(2)
})

async function restartFixture() {
  const { reserveTurn } = await import('../../src/server/discussion/turns')
  const original = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  const alias = { ...original, requestId: crypto.randomUUID() }
  const first = await reserveTurn(platform, user, original)
  expect((await reserveTurn(platform, user, alias)).id).toBe(first.id)
  return { reserveTurn, original, alias, first }
}
test.each(['DELETE', 'POST'] as const)(
  'restart keeps historical opening %s isolated from fresh attempt',
  async (method) => {
    const { reserveTurn, original, alias } = await restartFixture()
    const { cancelLogicalTurn } =
      await import('../../src/server/discussion/turns')
    await privacy.deleteConversation(platform, user, input.threadId, post)
    await privacy.restartDiscussion(platform, user, input.threadId)
    const fresh = { ...original, requestId: crypto.randomUUID() },
      attempt = await reserveTurn(platform, user, fresh)
    if (method === 'DELETE')
      expect(await cancelLogicalTurn(platform, user, alias)).toMatchObject({
        turn: null,
        cancelled: true,
      })
    else
      await expect(reserveTurn(platform, user, alias)).rejects.toMatchObject({
        code: 'TURN_CANCELLED',
      })
    expect((await getTurn(platform, user, attempt.id)).status).toBe('reserved')
    await expect(reserveTurn(platform, user, original)).rejects.toMatchObject({
      code: 'TURN_CANCELLED',
    })
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) n FROM ai_request_cancellations WHERE owner_id=? AND request_id IN (?,?)',
        )
          .bind(user.userId, original.requestId, alias.requestId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2)
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) n FROM ai_allowances WHERE owner_id=?',
        )
          .bind(user.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2)
    expect(
      (
        await env.DB.prepare('SELECT count(*) n FROM ai_usage WHERE owner_id=?')
          .bind(user.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2)
    expect(
      (await getSnapshot(platform, user, input.threadId)).thread.sourceRevision,
    ).toBe(1)
  },
)
test.each(['DELETE', 'POST'] as const)(
  'old opening %s preflight before restart cannot attach after restart',
  async (method) => {
    const { reserveTurn, original, alias } = await restartFixture()
    const { cancelLogicalTurn } =
      await import('../../src/server/discussion/turns')
    let ready!: () => void, release!: () => void
    const reached = new Promise<void>((r) => {
        ready = r
      }),
      held = new Promise<void>((r) => {
        release = r
      })
    const delayed = {
      ...platform,
      db: new Proxy(platform.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              ready()
              await held
              return target.batch(statements)
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    } as Platform
    const old =
      method === 'POST'
        ? reserveTurn(delayed, user, alias)
        : cancelLogicalTurn(delayed, user, alias)
    // Register a rejection handler before releasing to avoid unhandled-rejection noise.
    const result = old.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await reached
    await privacy.deleteConversation(platform, user, input.threadId, post)
    await privacy.restartDiscussion(platform, user, input.threadId)
    const attempt = await reserveTurn(platform, user, {
      ...original,
      requestId: crypto.randomUUID(),
    })
    release()
    const outcome = await result
    if (method === 'POST')
      expect(outcome).toMatchObject({ error: { code: 'TURN_CANCELLED' } })
    else
      expect(outcome).toMatchObject({ value: { turn: null, cancelled: true } })
    expect((await getTurn(platform, user, attempt.id)).status).toBe('reserved')
    expect(
      (
        await env.DB.prepare('SELECT count(*) n FROM ai_usage WHERE owner_id=?')
          .bind(user.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2)
  },
)
