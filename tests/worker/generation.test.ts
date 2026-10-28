import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import discussion from '../../drizzle/migrations/0005_discussion.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
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
  await applyMigration(env.DB, discussion)
  await applyMigration(env.DB, turns)
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
    vi
      .fn()
      .mockResolvedValue(
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
