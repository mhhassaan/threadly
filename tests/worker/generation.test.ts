import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import imports from '../../drizzle/migrations/0004_import.sql?raw'
import discussion from '../../drizzle/migrations/0005_discussion.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
import discussionUi from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
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
    text: 'Hello',
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
test('human_comment_survives_provider_failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('', { status: 401 })),
  )
  const result = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(result.status).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('concurrent_duplicate_calls_claim_once_and_reload_no_regeneration', async () => {
  const fetcher = vi.fn().mockResolvedValue(response())
  vi.stubGlobal('fetch', fetcher)
  const results = await Promise.all([
    runTurn(platform, user, input, new AbortController().signal),
    runTurn(platform, user, input, new AbortController().signal),
  ])
  expect(fetcher).toHaveBeenCalledTimes(1)
  const done = results.find((x) => x.status === 'complete')!
  expect((await getTurn(platform, user, done.id)).commentIds).toHaveLength(1)
  const comments = (await getSnapshot(platform, user, input.threadId)).comments
  expect(comments).toHaveLength(2)
  expect(comments[1].parentId).toBe(input.triggerCommentId)
})
test('edited_source_stales_result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await patchOwnedThread(platform, user, input.threadId, {
        expectedRevision: 1,
        posts: [{ id: post, text: 'Changed' }],
      })
      return response()
    }),
  )
  const result = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(result.status).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('cancel_blocks_late_result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM ai_turns WHERE status = 'running'",
      ).first<{ id: string }>()
      await cancelTurn(platform, user, row!.id)
      return response()
    }),
  )
  const result = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(result.status).toBe('cancelled')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})

test('invalid_json_no_comments', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '{' } }],
      }),
    ),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('missing_key_keeps_reading_and_manual_comments_available', async () => {
  const noKey = { ...platform, env: { ...platform.env, deepseekApiKey: '' } }
  await expect(
    runTurn(noKey, user, input, new AbortController().signal),
  ).rejects.toMatchObject({ status: 503 })
  expect(
    (await getSnapshot(noKey, user, input.threadId)).comments,
  ).toHaveLength(1)
  await appendHumanComment(noKey, user, {
    id: crypto.randomUUID(),
    threadId: input.threadId,
    postId: post,
    parentId: input.triggerCommentId,
    text: 'Still works',
  })
  expect(
    (await getSnapshot(noKey, user, input.threadId)).comments,
  ).toHaveLength(2)
})
test('three_replies_max', async () => {
  const comments = Array.from({ length: 4 }, (_, i) => ({
    id: `a${i}`,
    speakerId: getCast(input.threadId)[0].id,
    postId: post,
    parentId: input.triggerCommentId,
    batchParentId: null,
    text: 'Reply',
    passageIds: [],
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ comments }) },
          },
        ],
      }),
    ),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})

test('opening_leaves_quiet_post', async () => {
  const snapshot = await getSnapshot(platform, user, input.threadId)
  const comments = snapshot.thread.posts.map((p, i) => ({
    id: `a${i}`,
    speakerId: getCast(input.threadId)[0].id,
    postId: p.id,
    parentId: null,
    batchParentId: null,
    text: 'Reply',
    passageIds: [],
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ comments }) },
          },
        ],
      }),
    ),
  )
  const opening = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  expect(
    (await runTurn(platform, user, opening, new AbortController().signal))
      .status,
  ).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('memory_epoch_fences_inflight', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await env.DB.prepare(
        'UPDATE account_settings SET memory_epoch = memory_epoch + 1 WHERE owner_id = ?',
      )
        .bind(user.userId)
        .run()
      return response()
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})
test('guest_identity_persists_with_exchange', async () => {
  const guest = getCast(input.threadId).find((p) => p.kind === 'guest')!
  const reply = {
    id: 'a',
    speakerId: guest.id,
    postId: post,
    parentId: input.triggerCommentId,
    batchParentId: null,
    text: 'Guest response',
    passageIds: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ comments: [reply] }) },
          },
        ],
      }),
    ),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
  expect(
    await env.DB.prepare(
      'SELECT id FROM guest_identities WHERE owner_id = ? AND thread_id = ?',
    )
      .bind(user.userId, input.threadId)
      .first(),
  ).toMatchObject({ id: guest.id })
})

test('completion_before_cancel_returns_complete_and_keeps_comments', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  const done = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(done.status).toBe('complete')
  const cancelled = await cancelTurn(platform, user, done.id)
  expect(cancelled.status).toBe('complete')
  expect(cancelled.commentIds).toEqual(done.commentIds)
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(2)
})

test('batch_parents_and_source_citations_persist_exactly_once', async () => {
  const speaker = getCast(input.threadId)[0].id
  const comments = [
    {
      id: 'a',
      speakerId: speaker,
      postId: post,
      parentId: input.triggerCommentId,
      batchParentId: null,
      text: 'First',
      passageIds: ['p0-8'],
    },
    {
      id: 'b',
      speakerId: speaker,
      postId: post,
      parentId: null,
      batchParentId: 'a',
      text: 'Second',
      passageIds: ['p0-8'],
    },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ comments }) },
          },
        ],
      }),
    ),
  )
  const done = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(done.status).toBe('complete')
  const saved = (await getSnapshot(platform, user, input.threadId)).comments
  expect(saved).toHaveLength(3)
  expect(saved[2].parentId).toBe(saved[1].id)
  expect(saved[1].passageIds).toEqual(['p0-8'])
  expect(
    await env.DB.prepare(
      'SELECT id, text FROM source_passages WHERE owner_id = ? AND thread_id = ?',
    )
      .bind(user.userId, input.threadId)
      .first(),
  ).toEqual({ id: 'p0-8', text: 'Evidence' })
  expect(
    (await runTurn(platform, user, input, new AbortController().signal))
      .commentIds,
  ).toEqual(done.commentIds)
})

test('delayed_finalization_after_database_lease_expiry_publishes_nothing_and_retries', async () => {
  let delayFinalBatch = false
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (delayFinalBatch) {
            delayFinalBatch = false
            await new Promise((resolve) => setTimeout(resolve, 2500))
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const delayed = { ...platform, db }
  const guest = getCast(input.threadId).find((p) => p.kind === 'guest')!
  const comment = {
    id: 'a',
    speakerId: guest.id,
    postId: post,
    parentId: input.triggerCommentId,
    batchParentId: null,
    text: 'Reply',
    passageIds: ['p0-8'],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await env.DB.prepare(
        "UPDATE ai_turns SET lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+2 seconds') WHERE status = 'running'",
      ).run()
      delayFinalBatch = true
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ comments: [comment] }) },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })
    }),
  )
  const old = await runTurn(delayed, user, input, new AbortController().signal)
  expect(old.status).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
  expect(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM source_passages').first<{
      n: number
    }>())!.n,
  ).toBe(0)
  expect(
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM guest_identities').first<{
      n: number
    }>())!.n,
  ).toBe(0)
  expect(
    await env.DB.prepare(
      'SELECT input_tokens, output_tokens, estimated_cost_micros FROM ai_usage WHERE turn_id = ?',
    )
      .bind(old.id)
      .first(),
  ).toEqual({
    input_tokens: null,
    output_tokens: null,
    estimated_cost_micros: null,
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  const next = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(next.id).not.toBe(old.id)
  expect(next.status).toBe('complete')
})

test('admitted_batch_remains_atomic_if_lease_expires_between_statements', async () => {
  let intercept = false
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'batch')
        return (statements: D1PreparedStatement[]) => {
          if (intercept) {
            intercept = false
            statements = [
              statements[0],
              target.prepare(
                "UPDATE ai_turns SET lease_until = '2000-01-01T00:00:00.000Z' WHERE status = 'complete'",
              ),
              ...statements.slice(1),
            ]
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      intercept = true
      return response()
    }),
  )
  const done = await runTurn(
    { ...platform, db },
    user,
    input,
    new AbortController().signal,
  )
  expect(done.status).toBe('complete')
  expect(done.commentIds).toHaveLength(1)
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(2)
  expect(
    await env.DB.prepare(
      'SELECT input_tokens, output_tokens FROM ai_usage WHERE turn_id = ?',
    )
      .bind(done.id)
      .first(),
  ).toEqual({ input_tokens: 5, output_tokens: 3 })
})

// The UI may cancel before the synchronous generation POST has reserved an attempt.
test('logical_cancel_before_reservation_blocks_provider_and_spend', async () => {
  const { cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const result = await cancelLogicalTurn(platform, user, input)
  expect(result).toEqual({ turn: null, cancelled: true })
  const provider = vi.fn().mockResolvedValue(response())
  vi.stubGlobal('fetch', provider)
  await expect(
    runTurn(platform, user, input, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'TURN_CANCELLED' })
  expect(provider).not.toHaveBeenCalled()
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_usage').first(),
  ).toEqual({ n: 0 })
})

test('logical_status_reads_running_and_cancel_wins', async () => {
  const { getLogicalTurn, cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const { reserveTurn } = await import('../../src/server/discussion/turns')
  const attempt = await reserveTurn(platform, user, input)
  expect((await getLogicalTurn(platform, user, input)).turn?.id).toBe(
    attempt.id,
  )
  expect((await cancelLogicalTurn(platform, user, input)).turn?.status).toBe(
    'cancelled',
  )
})

test('logical_cancel_after_completion_returns_completed_comments', async () => {
  const { cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  const completed = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  const result = await cancelLogicalTurn(platform, user, input)
  expect(result.cancelled).toBe(false)
  expect(result.turn).toEqual(completed)
})

test('logical_cancel_rejects_reused_request_identity', async () => {
  const { cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  await cancelLogicalTurn(platform, user, input)
  const changed = { ...input, kind: 'opening' as const, triggerCommentId: null }
  await expect(
    cancelLogicalTurn(platform, user, changed),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
})

test('logical_cancel_while_running_blocks_late_publication', async () => {
  const { cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return response()
    }),
  )
  const pending = runTurn(platform, user, input, new AbortController().signal)
  await began
  const cancelled = await cancelLogicalTurn(platform, user, input)
  expect(cancelled.turn?.status).toBe('cancelled')
  release()
  expect((await pending).status).toBe('cancelled')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})

test('logical_cancel_rejects_identity_of_existing_request', async () => {
  const { cancelLogicalTurn, reserveTurn, getTurn } =
    await import('../../src/server/discussion/turns')
  const attempt = await reserveTurn(platform, user, input)
  await expect(
    cancelLogicalTurn(platform, user, {
      ...input,
      kind: 'opening',
      triggerCommentId: null,
    }),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  expect((await getTurn(platform, user, attempt.id)).status).toBe('reserved')
})

test('logical_status_rejects_mismatched_request_identity', async () => {
  const { getLogicalTurn, reserveTurn } =
    await import('../../src/server/discussion/turns')
  await reserveTurn(platform, user, input)
  await expect(
    getLogicalTurn(platform, user, {
      ...input,
      kind: 'opening',
      triggerCommentId: null,
    }),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
})

test('logical_endpoints_validate_trigger_owner_and_kind', async () => {
  const { getLogicalTurn, cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  for (const operation of [getLogicalTurn, cancelLogicalTurn]) {
    await expect(
      operation(platform, user, {
        ...input,
        triggerCommentId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      operation(platform, user, { ...input, kind: 'opening' }),
    ).rejects.toMatchObject({ status: 400 })
  }
})

test('logical_cancel_and_reservation_are_serialized', async () => {
  const { cancelLogicalTurn, reserveTurn, getLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const [cancel, reserve] = await Promise.allSettled([
    cancelLogicalTurn(platform, user, input),
    reserveTurn(platform, user, input),
  ])
  expect(cancel.status).toBe('fulfilled')
  if (reserve.status === 'rejected')
    expect(reserve.reason).toMatchObject({ code: 'TURN_CANCELLED' })
  const status = await getLogicalTurn(platform, user, input)
  expect(status.cancelled).toBe(true)
  expect(status.turn === null || status.turn.status === 'cancelled').toBe(true)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM ai_turns WHERE status IN ('reserved','running')",
    ).first(),
  ).toEqual({ n: 0 })
})

test('logical_opening_lookup_uses_thread_and_source_revision', async () => {
  const { cancelLogicalTurn, getLogicalTurn, reserveTurn } =
    await import('../../src/server/discussion/turns')
  const opening = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  const attempt = await reserveTurn(platform, user, opening)
  const otherRequest = { ...opening, requestId: crypto.randomUUID() }
  expect((await getLogicalTurn(platform, user, otherRequest)).turn?.id).toBe(
    attempt.id,
  )
  expect(
    (await cancelLogicalTurn(platform, user, otherRequest)).turn?.status,
  ).toBe('cancelled')
})

test('fresh_opening_after_cancel_keeps_old_alias_and_allowance', async () => {
  const { reserveTurn, cancelLogicalTurn, getLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const original = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  const first = await reserveTurn(platform, user, original)
  await cancelLogicalTurn(platform, user, original)
  const nextInput = { ...original, requestId: crypto.randomUUID() }
  const second = await reserveTurn(platform, user, nextInput)
  expect(second.id).not.toBe(first.id)
  expect(second.status).toBe('reserved')
  expect((await getLogicalTurn(platform, user, original)).turn?.id).toBe(
    first.id,
  )
  expect((await cancelLogicalTurn(platform, user, original)).turn?.status).toBe(
    'cancelled',
  )
  expect((await getTurn(platform, user, second.id)).status).toBe('reserved')
  expect(
    (
      await env.DB.prepare('SELECT count(*) n FROM ai_allowances').first<{
        n: number
      }>()
    )?.n,
  ).toBe(1)
  expect(
    (
      await env.DB.prepare('SELECT count(*) n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(2)
  expect(
    (
      await env.DB.prepare('SELECT count(*) n FROM ai_requests').first<{
        n: number
      }>()
    )?.n,
  ).toBe(1)
  expect((await reserveTurn(platform, user, original)).id).toBe(first.id)
})

test('opening_alias_cannot_be_reused_for_another_thread_or_reply_and_completed_opening_dedupes', async () => {
  const { reserveTurn, cancelLogicalTurn, getLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const firstInput = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  await reserveTurn(platform, user, firstInput)
  await cancelLogicalTurn(platform, user, firstInput)
  const nextInput = { ...firstInput, requestId: crypto.randomUUID() }
  const second = await reserveTurn(platform, user, nextInput)
  await env.DB.prepare("UPDATE ai_turns SET status = 'complete' WHERE id = ?")
    .bind(second.id)
    .run()
  const duplicate = await reserveTurn(platform, user, {
    ...firstInput,
    requestId: crypto.randomUUID(),
  })
  expect(duplicate.id).toBe(second.id)
  expect((await getLogicalTurn(platform, user, firstInput)).turn?.status).toBe(
    'cancelled',
  )
  await expect(
    reserveTurn(platform, user, { ...input, requestId: nextInput.requestId }),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  const other = await saveThread(
    platform,
    user,
    {
      id: crypto.randomUUID(),
      title: 'Other',
      posts: ['Other'],
      sourceUrl: '',
      source: null,
      media: [],
      interactions: {},
    },
    null,
  )
  await expect(
    getLogicalTurn(platform, user, { ...nextInput, threadId: other.id }),
  ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  expect(
    (
      await env.DB.prepare('SELECT count(*) n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(2)
})

test('opening_alias_racing_other_request_identity_does_not_spend_or_cancel_other_thread', async () => {
  const { reserveTurn, cancelLogicalTurn } =
    await import('../../src/server/discussion/turns')
  const original = {
    requestId: crypto.randomUUID(),
    threadId: input.threadId,
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  await reserveTurn(platform, user, original)
  await cancelLogicalTurn(platform, user, original)
  const other = await saveThread(
    platform,
    user,
    {
      id: crypto.randomUUID(),
      title: 'Other',
      posts: ['Other'],
      sourceUrl: '',
      source: null,
      media: [],
      interactions: {},
    },
    null,
  )
  const humanId = crypto.randomUUID()
  await appendHumanComment(platform, user, {
    id: humanId,
    threadId: other.id,
    postId: other.posts[0].id,
    parentId: null,
    text: 'Other question',
  })
  const next = { ...original, requestId: crypto.randomUUID() }
  let intercepted = false
  const racing = {
    ...platform,
    db: {
      prepare: platform.db.prepare.bind(platform.db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true
          await reserveTurn(platform, user, {
            requestId: next.requestId,
            threadId: other.id,
            kind: 'reply',
            triggerCommentId: humanId,
          })
        }
        return platform.db.batch(statements)
      },
    },
  } as Platform
  await expect(reserveTurn(racing, user, next)).rejects.toMatchObject({
    code: 'REQUEST_CONFLICT',
  })
  await expect(cancelLogicalTurn(platform, user, next)).rejects.toMatchObject({
    code: 'REQUEST_CONFLICT',
  })
  expect(
    (
      await env.DB.prepare('SELECT count(*) n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(2)
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM ai_turns WHERE thread_id = ? AND status IN ('reserved','running')",
      )
        .bind(other.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1)
  for (const table of [
    'ai_requests',
    'ai_allowances',
    'ai_turns',
    'ai_usage',
  ]) {
    expect(
      (
        await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first<{
          n: number
        }>()
      )?.n,
    ).toBe(2)
  }
  expect(
    await env.DB.prepare(
      'SELECT 1 FROM ai_opening_admissions WHERE request_id = ?',
    )
      .bind(next.requestId)
      .first(),
  ).toBeNull()
})

test.each(['reply', 'opening'] as const)(
  'opening_cancel_racing_%s_identity_does_not_poison_tombstone',
  async (kind) => {
    const { reserveTurn, cancelLogicalTurn, getLogicalTurn } =
      await import('../../src/server/discussion/turns')
    const original = {
      requestId: crypto.randomUUID(),
      threadId: input.threadId,
      kind: 'opening' as const,
      triggerCommentId: null,
    }
    await reserveTurn(platform, user, original)
    await cancelLogicalTurn(platform, user, original)
    const other = await saveThread(
      platform,
      user,
      {
        id: crypto.randomUUID(),
        title: 'Other',
        posts: ['Other'],
        sourceUrl: '',
        source: null,
        media: [],
        interactions: {},
      },
      null,
    )
    const humanId = crypto.randomUUID()
    await appendHumanComment(platform, user, {
      id: humanId,
      threadId: other.id,
      postId: other.posts[0].id,
      parentId: null,
      text: 'Other question',
    })
    const next = { ...original, requestId: crypto.randomUUID() }
    const reply = {
      requestId: next.requestId,
      threadId: other.id,
      kind,
      triggerCommentId: kind === 'reply' ? humanId : null,
    }
    let intercepted = false
    const racing = {
      ...platform,
      db: {
        prepare: platform.db.prepare.bind(platform.db),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true
            await reserveTurn(platform, user, reply)
          }
          return platform.db.batch(statements)
        },
      },
    } as Platform
    await expect(cancelLogicalTurn(racing, user, next)).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    })
    expect((await getLogicalTurn(platform, user, reply)).turn?.status).toBe(
      'reserved',
    )
    expect(
      await env.DB.prepare(
        'SELECT 1 FROM ai_request_cancellations WHERE request_id = ?',
      )
        .bind(next.requestId)
        .first(),
    ).toBeNull()
  },
)
