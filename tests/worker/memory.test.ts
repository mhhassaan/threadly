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
test('regular_recalls_cross_thread', async () => {
  await remember()
  const memories = await retrieve()
  expect(memories).toHaveLength(1)
  expect(memories[0]).toMatchObject({
    personaId: regular,
    text: quote,
    evidenceIds: [input.triggerCommentId],
    epoch: 0,
  })
  expect(
    await inspectMemories(
      platform,
      user,
      memories.map((m) => m.id),
    ),
  ).toEqual([]) // not yet used in a reply
})
test('guest_has_no_cross_thread_memory', async () => {
  await remember()
  expect(
    await retrieve([
      getCast(input.threadId).find((p) => p.kind === 'guest')!.id,
    ]),
  ).toEqual([])
})
test('different_owner_no_memory', async () => {
  await remember()
  expect(await retrieve([regular], { ...user, userId: 'bob' })).toEqual([])
})
test('clear_epoch_blocks_inflight_update', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      await env.DB.prepare(
        'UPDATE account_settings SET memory_epoch = memory_epoch + 1 WHERE owner_id = ?',
      )
        .bind(user.userId)
        .run()
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
  const turn = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(turn.status).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
  expect(await retrieve()).toEqual([])
})
test('memory_disabled_no_read_or_write', async () => {
  await remember()
  await updateSettings(platform, user, { memoryEnabled: false })
  expect(await retrieve()).toEqual([])
  input.requestId = crypto.randomUUID()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const r = (await response().json()) as any
      const e = JSON.parse(r.choices[0].message.content)
      e.memoryUpdates = []
      r.choices[0].message.content = JSON.stringify(e)
      return Response.json(r)
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
  expect(
    (await env.DB.prepare(
      'SELECT count(*) AS n FROM participant_memories',
    ).first<{ n: number }>())!.n,
  ).toBe(1)
})
test('deleted_evidence_not_retrieved', async () => {
  await remember()
  // This root evidence has an AI child: delete the dependent reply first.
  await env.DB.prepare("DELETE FROM comments WHERE author_kind = 'ai'").run()
  await env.DB.prepare('DELETE FROM comments WHERE id = ?')
    .bind(input.triggerCommentId)
    .run()
  expect(await retrieve()).toEqual([])
})

async function nextThread(text = 'What about solar storage costs?') {
  const id = crypto.randomUUID()
  const saved = await saveThread(
    platform,
    user,
    {
      id,
      title: 'New solar discussion',
      posts: ['Solar storage costs'],
      sourceUrl: '',
      source: null,
      media: [],
      interactions: {},
    },
    null,
  )
  post = saved.posts[0].id
  const human = crypto.randomUUID()
  await appendHumanComment(platform, user, {
    id: human,
    threadId: id,
    postId: post,
    parentId: null,
    text,
  })
  input = {
    requestId: crypto.randomUUID(),
    threadId: id,
    kind: 'reply',
    triggerCommentId: human,
  }
}
function provider(exchange: unknown) {
  return Response.json({
    choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(exchange) } },
    ],
    usage: { prompt_tokens: 2000, completion_tokens: 100 },
  })
}
async function replyExchange() {
  return JSON.parse(
    ((await response().json()) as any).choices[0].message.content,
  )
}
test('corrected_argument_in_new_thread_has_matching_inspectable_provenance_and_no_guest_context', async () => {
  await remember()
  const [memory] = await retrieve()
  const oldEvidence = input.triggerCommentId
  await nextThread()
  let sent: any
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, options) => {
      sent = JSON.parse(options.body)
      const exchange = await replyExchange()
      exchange.comments[0].text =
        'You earlier said storage costs remain uncertain. That correction still matters here.'
      return provider(exchange)
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
  const data = JSON.parse(sent.messages[1].content)
  expect(data.memories.map((m: any) => m.id)).toEqual([memory.id])
  expect(sent.messages[0].content).not.toContain('echo_guest_ai')
  const comments = (await getSnapshot(platform, user, input.threadId)).comments
  expect(comments.at(-1)!.usedMemoryIds).toEqual([memory.id])
  const inspected = await inspectMemories(platform, user, [memory.id])
  expect(inspected[0].evidence[0]).toMatchObject({
    id: oldEvidence,
    text: quote,
  })
  expect(
    await inspectMemories(platform, { ...user, userId: 'bob' }, [memory.id]),
  ).toEqual([])
})
test('memory_free_guest_turn_still_works', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const exchange = await replyExchange()
      exchange.comments[0].speakerId = getCast(input.threadId).find(
        (p) => p.kind === 'guest',
      )!.id
      return provider(exchange)
    }),
  )
  const turn = await runTurn(
    platform,
    user,
    input,
    new AbortController().signal,
  )
  expect(turn.status).toBe('complete')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments.at(-1)!
      .usedMemoryIds,
  ).toEqual([])
})
test.each([
  'inferred_profile',
  'guest_update',
  'nonparticipating_regular',
  'invented_evidence',
  'partial_quote',
  'three_updates',
  'oversize_update',
])('rejects_%s_without_memory_or_comments', async (mode) => {
  await updateSettings(platform, user, { memoryEnabled: true })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const exchange = await replyExchange()
      const update = {
        personaId: regular,
        text: quote,
        evidenceIds: [input.triggerCommentId],
      }
      if (mode === 'inferred_profile')
        update.text = 'The user likely has a psychiatric diagnosis.'
      if (mode === 'guest_update')
        update.personaId = getCast(input.threadId).find(
          (p) => p.kind === 'guest',
        )!.id
      if (mode === 'nonparticipating_regular')
        update.personaId = getCast(input.threadId)[1].id
      if (mode === 'invented_evidence')
        update.evidenceIds = [crypto.randomUUID()]
      if (mode === 'partial_quote') update.text = 'solar storage costs'
      if (mode === 'oversize_update') update.text = 'x'.repeat(601)
      exchange.memoryUpdates =
        mode === 'three_updates' ? [update, update, update] : [update]
      return provider(exchange)
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
  expect(await retrieve()).toEqual([])
})
test('reset_during_delayed_provider_response_saves_neither_comments_nor_memory', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
  let release!: () => void, started!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      started()
      await pending
      const exchange = await replyExchange()
      exchange.memoryUpdates = [
        {
          personaId: regular,
          text: quote,
          evidenceIds: [input.triggerCommentId],
        },
      ]
      return provider(exchange)
    }),
  )
  const running = runTurn(platform, user, input, new AbortController().signal)
  await ready
  await env.DB.prepare(
    "UPDATE account_settings SET memory_epoch = memory_epoch + 1, memory_reset_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner_id = ?",
  )
    .bind(user.userId)
    .run()
  release()
  expect((await running).status).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
  expect(await retrieve()).toEqual([])
})
test('global_and_persona_reset_cutoffs_block_old_history_reextraction', async () => {
  await remember()
  await env.DB.prepare(
    "UPDATE account_settings SET memory_epoch = 1, memory_reset_at = '2099-01-01' WHERE owner_id = ?",
  )
    .bind(user.userId)
    .run()
  input.requestId = crypto.randomUUID()
  // The exact old quote remains in saved history, but cannot become new memory.
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
  expect(await retrieve()).toEqual([])
  expect(
    (await env.DB.prepare(
      'SELECT count(*) AS n FROM participant_memories WHERE epoch = 1',
    ).first<{ n: number }>())!.n,
  ).toBe(0)
  await env.DB.prepare(
    'UPDATE account_settings SET memory_reset_at = NULL WHERE owner_id = ?',
  )
    .bind(user.userId)
    .run()
  await env.DB.prepare("INSERT INTO memory_resets VALUES (?, ?, '2099-01-01')")
    .bind(user.userId, regular)
    .run()
  input.requestId = crypto.randomUUID()
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('complete')
  expect(await retrieve()).toEqual([])
})
test('edited_support_is_invalid_and_retrieval_is_bounded', async () => {
  await remember()
  expect(
    await getRelevantMemories(platform, user, {
      personaIds: [regular],
      text: 'solar storage',
      limit: 99,
    }),
  ).toHaveLength(1)
  const snapshot = await getSnapshot(platform, user, input.threadId)
  await patchOwnedThread(platform, user, input.threadId, {
    expectedRevision: snapshot.thread.revision,
    posts: [{ id: post, text: 'Changed source argument' }],
  })
  expect(await retrieve()).toEqual([])
})
test('invalidated_cross_thread_memory_before_publication_blocks_reply', async () => {
  await remember()
  const oldThread = input.threadId
  await nextThread()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      await env.DB.prepare(
        'UPDATE owned_threads SET revision = revision + 1 WHERE id = ?',
      )
        .bind(oldThread)
        .run()
      return provider(await replyExchange())
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('stale')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(1)
})

test('current_nonzero_epoch_is_authoritative_even_with_empty_retrieval', async () => {
  await env.DB.prepare(
    'UPDATE account_settings SET memory_epoch = 7, memory_enabled = 1 WHERE owner_id = ?',
  )
    .bind(user.userId)
    .run()
  await remember()
  expect((await retrieve())[0].epoch).toBe(7)
})
test('disabled_memory_rejects_provider_updates_and_retains_history', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const exchange = await replyExchange()
      exchange.memoryUpdates = [
        {
          personaId: regular,
          text: quote,
          evidenceIds: [input.triggerCommentId],
        },
      ]
      return provider(exchange)
    }),
  )
  expect(
    (await runTurn(platform, user, input, new AbortController().signal)).status,
  ).toBe('failed')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments[0].text,
  ).toBe(quote)
  expect(await retrieve()).toEqual([])
})
test('memory_batch_failure_rolls_back_comments_and_memory_together', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const exchange = await replyExchange()
      exchange.memoryUpdates = [
        {
          personaId: regular,
          text: quote,
          evidenceIds: [input.triggerCommentId],
        },
      ]
      return provider(exchange)
    }),
  )
  await env.DB.prepare(
    "CREATE TRIGGER reject_memory BEFORE INSERT ON memory_evidence BEGIN SELECT RAISE(ABORT, 'test memory failure'); END",
  ).run()
  try {
    expect(
      (await runTurn(platform, user, input, new AbortController().signal))
        .status,
    ).toBe('failed')
    expect(
      (await getSnapshot(platform, user, input.threadId)).comments,
    ).toHaveLength(1)
    expect(
      (await env.DB.prepare(
        'SELECT count(*) AS n FROM participant_memories',
      ).first<{ n: number }>())!.n,
    ).toBe(0)
  } finally {
    await env.DB.prepare('DROP TRIGGER reject_memory').run()
  }
})
test('admitted_marker_batch_saves_memory_if_clock_lease_expires_between_statements', async () => {
  await updateSettings(platform, user, { memoryEnabled: true })
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
    vi.fn().mockImplementation(async () => {
      const exchange = await replyExchange()
      exchange.memoryUpdates = [
        {
          personaId: regular,
          text: quote,
          evidenceIds: [input.triggerCommentId],
        },
      ]
      intercept = true
      return provider(exchange)
    }),
  )
  expect(
    (
      await runTurn(
        { ...platform, db },
        user,
        input,
        new AbortController().signal,
      )
    ).status,
  ).toBe('complete')
  expect(
    (await getSnapshot(platform, user, input.threadId)).comments,
  ).toHaveLength(2)
  expect(await retrieve()).toHaveLength(1)
})
