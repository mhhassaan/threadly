import type {
  TurnInput,
  TurnState,
  UserContext,
} from '../../lib/account-thread'
import type { Platform } from '../platform'
import { getSnapshot } from '../data/threads'
import { buildContext } from './context'
import { getCast } from './cast'
import { validateExchange } from './contracts'
import { splitSource } from './source'
import { callDeepSeek } from './deepseek'
import { finalizationFence, getTurn, reserveTurn } from './turns'

export async function runTurn(
  p: Platform,
  u: UserContext,
  input: TurnInput,
  signal: AbortSignal,
  currentPlatform: () => Platform = () => p,
): Promise<TurnState> {
  // Validate the owner-authorized trigger before consuming an allowance.
  const initial = await getSnapshot(p, u, input.threadId)
  buildContext(initial, input, [], getCast(input.threadId))
  const turn = await reserveTurn(p, u, input)
  const claimed = await p.db
    .prepare(
      "UPDATE ai_turns SET status = 'running' WHERE id = ? AND owner_id = ? AND status = 'reserved' AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(turn.id, u.userId)
    .run()
  if (claimed.meta.changes !== 1) {
    await p.db
      .prepare(
        "UPDATE ai_turns SET status = 'stale', error_code = 'LEASE_EXPIRED' WHERE id = ? AND owner_id = ? AND status = 'reserved' AND lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      )
      .bind(turn.id, u.userId)
      .run()
    return getTurn(p, u, turn.id)
  }
  const finishStale = async () => {
    await p.db
      .prepare(
        "UPDATE ai_turns SET status = 'stale', error_code = 'TURN_STALE' WHERE id = ? AND owner_id = ? AND status IN ('reserved','running')",
      )
      .bind(turn.id, u.userId)
      .run()
    return getTurn(p, u, turn.id)
  }
  try {
    const snapshot = await getSnapshot(p, u, input.threadId)
    const row = await p.db
      .prepare(
        'SELECT thread_revision, source_revision, memory_epoch FROM ai_turns WHERE id = ? AND owner_id = ?',
      )
      .bind(turn.id, u.userId)
      .first<{
        thread_revision: number
        source_revision: number
        memory_epoch: number
      }>()
    if (
      !row ||
      snapshot.thread.revision !== row.thread_revision ||
      snapshot.thread.sourceRevision !== row.source_revision ||
      signal.aborted
    )
      return finishStale()
    const context = buildContext(snapshot, input, [], getCast(input.threadId))
    context.memoryEpoch = row.memory_epoch
    const { exchange: raw, usage } = await callDeepSeek(p, context, signal)
    const exchange = validateExchange(raw, context)
    if (signal.aborted || !currentPlatform().env.aiEnabled) return finishStale()
    const now = new Date().toISOString()
    const marker = crypto.randomUUID()
    // The first statement admits the entire transaction once using DB time.
    // The private marker gates all dependent writes even if the lease expires
    // between statements; it is removed before the transaction commits.
    const fence = `EXISTS (SELECT 1 FROM ai_turns WHERE id = ? AND owner_id = ? AND status = 'complete' AND error_code = ?)`
    const statements: D1PreparedStatement[] = [
      p.db
        .prepare(
          `UPDATE ai_turns SET status = 'complete', error_code = ? WHERE id = ? AND owner_id = ? AND ${finalizationFence}`,
        )
        .bind(marker, turn.id, u.userId),
    ]
    const guest = getCast(input.threadId).find(
      (persona) =>
        persona.kind === 'guest' &&
        exchange.comments.some((comment) => comment.speakerId === persona.id),
    )
    if (guest)
      statements.push(
        p.db
          .prepare(
            `INSERT INTO guest_identities (id, thread_id, owner_id, name, handle, voice, version) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${fence} ON CONFLICT DO NOTHING`,
          )
          .bind(
            guest.id,
            input.threadId,
            u.userId,
            guest.name,
            guest.handle,
            guest.voice,
            guest.version,
            turn.id,
            u.userId,
            marker,
          ),
      )
    const usedPassages = new Set(exchange.comments.flatMap((c) => c.passageIds))
    const passages = splitSource(
      snapshot.thread.record.sourceText ?? '',
    ).filter((x) => usedPassages.has(x.id))
    for (const passage of passages)
      statements.push(
        p.db
          .prepare(
            `INSERT INTO source_passages (id, thread_id, owner_id, source_revision, start_offset, end_offset, text) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${fence} ON CONFLICT DO NOTHING`,
          )
          .bind(
            passage.id,
            input.threadId,
            u.userId,
            row.source_revision,
            passage.start,
            passage.end,
            passage.text,
            turn.id,
            u.userId,
            marker,
          ),
      )
    const ids = new Map(
      exchange.comments.map((c) => [c.id, crypto.randomUUID()]),
    )
    for (const comment of exchange.comments)
      statements.push(
        p.db
          .prepare(
            `INSERT INTO comments (id, thread_id, post_id, owner_id, parent_id, author_kind, author_id, text, sequence, created_at, turn_id, passage_ids) SELECT ?, ?, ?, ?, ?, 'ai', ?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM comments WHERE thread_id = ? AND owner_id = ?), ?, ?, ? WHERE ${fence}`,
          )
          .bind(
            ids.get(comment.id),
            input.threadId,
            comment.postId,
            u.userId,
            comment.batchParentId
              ? ids.get(comment.batchParentId)
              : comment.parentId,
            comment.speakerId,
            comment.text,
            input.threadId,
            u.userId,
            now,
            turn.id,
            JSON.stringify(comment.passageIds),
            turn.id,
            u.userId,
            marker,
          ),
      )
    statements.push(
      p.db
        .prepare(
          `UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, estimated_cost_micros = ?, reserved_micros = MAX(reserved_micros, COALESCE(?, 0)) WHERE turn_id = ? AND owner_id = ? AND ${fence}`,
        )
        .bind(
          usage.inputTokens,
          usage.outputTokens,
          usage.estimatedCostMicros,
          usage.estimatedCostMicros,
          turn.id,
          u.userId,
          turn.id,
          u.userId,
          marker,
        ),
    )
    statements.push(
      p.db
        .prepare(
          `UPDATE ai_turns SET error_code = NULL WHERE id = ? AND owner_id = ? AND error_code = ?`,
        )
        .bind(turn.id, u.userId, marker),
    )
    const result = await p.db.batch(statements)
    if (result[0].meta.changes !== 1) return finishStale()
    return getTurn(p, u, turn.id)
  } catch {
    if (signal.aborted || !currentPlatform().env.aiEnabled) return finishStale()
    const result = await p.db
      .prepare(
        `UPDATE ai_turns SET status = 'failed', error_code = 'GENERATION_FAILED' WHERE id = ? AND owner_id = ? AND ${finalizationFence}`,
      )
      .bind(turn.id, u.userId)
      .run()
    if (!result.meta.changes) return finishStale()
    return getTurn(p, u, turn.id)
  }
}
