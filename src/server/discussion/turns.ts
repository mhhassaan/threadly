import {
  ApiError,
  type UserContext,
  type TurnInput,
  type TurnState,
} from '../../lib/account-thread'
import type { Platform } from '../platform'
import { requireVerified, notFound } from '../data/threads'
import { uuid } from '../data/validation'
import { budget } from './budget'

type TurnRow = {
  id: string
  status: TurnState['status']
  error_code: string | null
  logical_request_id?: string
}
function dto(row: TurnRow): TurnState {
  return {
    id: row.id,
    status: row.status,
    commentIds: [],
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  }
}
export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  estimatedCostMicros: number | null
}
export async function getTurn(
  p: Platform,
  u: UserContext,
  id: string,
): Promise<TurnState> {
  requireVerified(u)
  uuid(id)
  const row = await p.db
    .prepare(
      'SELECT id, status, error_code FROM ai_turns WHERE id = ? AND owner_id = ?',
    )
    .bind(id, u.userId)
    .first<TurnRow>()
  if (!row) notFound()
  const comments = await p.db
    .prepare(
      'SELECT id FROM comments WHERE turn_id = ? AND owner_id = ? ORDER BY sequence',
    )
    .bind(id, u.userId)
    .all<{ id: string }>()
  return { ...dto(row), commentIds: comments.results.map((x) => x.id) }
}
export async function reserveTurn(
  p: Platform,
  u: UserContext,
  input: TurnInput,
): Promise<TurnState> {
  requireVerified(u)
  uuid(input.requestId)
  uuid(input.threadId)
  if (input.kind !== 'opening' && input.kind !== 'reply')
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid turn kind')
  if (input.triggerCommentId !== null) uuid(input.triggerCommentId)
  const { worst, ceiling } = budget(p)
  const now = new Date()
  const timestamp = now.toISOString()
  const day = timestamp.slice(0, 10)
  const lease = new Date(now.getTime() + 90_000).toISOString()
  const logical = crypto.randomUUID()
  const attempt = crypto.randomUUID()
  const eligibility = `EXISTS (SELECT 1 FROM account_settings s WHERE s.owner_id = ? AND s.ai_enabled = 1 AND s.consent_at IS NOT NULL) AND (SELECT count(*) FROM ai_turns WHERE owner_id = ? AND status IN ('reserved','running')) < 3 AND NOT EXISTS (SELECT 1 FROM ai_turns WHERE owner_id = ? AND thread_id = ? AND status IN ('reserved','running')) AND COALESCE((SELECT sum(reserved_micros) FROM ai_usage WHERE utc_day = ?), 0) + ? <= ?`
  const bindings = [
    u.userId,
    u.userId,
    u.userId,
    input.threadId,
    day,
    worst,
    ceiling,
  ]
  const statements = [
    p.db
      .prepare(
        "UPDATE ai_turns SET status = 'stale', error_code = 'LEASE_EXPIRED' WHERE status IN ('reserved','running') AND lease_until <= ?",
      )
      .bind(timestamp),
    p.db
      .prepare(
        `INSERT INTO ai_requests (id, owner_id, request_id, thread_id, kind, trigger_comment_id, source_revision, utc_day)
      SELECT ?, ?, ?, t.id, ?, ?, t.source_revision, ? FROM owned_threads t WHERE t.id = ? AND t.owner_id = ? AND ${eligibility}
      AND (SELECT count(*) FROM ai_allowances WHERE owner_id = ? AND utc_day = ? AND kind = ?) < CASE WHEN ? = 'opening' THEN 5 ELSE 30 END
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        logical,
        u.userId,
        input.requestId,
        input.kind,
        input.triggerCommentId,
        day,
        input.threadId,
        u.userId,
        ...bindings,
        u.userId,
        day,
        input.kind,
        input.kind,
      ),
    p.db
      .prepare(
        'INSERT INTO ai_allowances (request_id, owner_id, utc_day, kind) SELECT id, owner_id, utc_day, kind FROM ai_requests WHERE id = ?',
      )
      .bind(logical),
    p.db
      .prepare(
        `INSERT INTO ai_turns (id, request_id, owner_id, thread_id, status, lease_until, thread_revision, source_revision, settings_epoch, memory_epoch, created_at)
      SELECT ?, r.id, r.owner_id, r.thread_id, 'reserved', ?, t.revision, t.source_revision, s.settings_epoch, s.memory_epoch, ? FROM ai_requests r JOIN owned_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id JOIN account_settings s ON s.owner_id = r.owner_id
      WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND r.request_id = ? AND r.source_revision = t.source_revision AND (r.kind = 'opening' OR r.trigger_comment_id IS ?) AND ${eligibility}
      AND NOT EXISTS (SELECT 1 FROM ai_turns prior WHERE prior.request_id = r.id AND prior.status NOT IN ('failed','stale'))
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        attempt,
        lease,
        timestamp,
        u.userId,
        input.threadId,
        input.kind,
        input.requestId,
        input.triggerCommentId,
        ...bindings,
      ),
    p.db
      .prepare(
        'INSERT INTO ai_usage (turn_id, owner_id, utc_day, reserved_micros) SELECT id, owner_id, ?, ? FROM ai_turns WHERE id = ?',
      )
      .bind(day, worst, attempt),
  ]
  await p.db.batch(statements)
  const row = await p.db
    .prepare(
      `SELECT a.id, a.status, a.error_code, r.request_id AS logical_request_id FROM ai_requests r JOIN ai_turns a ON a.request_id = r.id JOIN owned_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND ((r.kind = 'opening' AND r.source_revision = t.source_revision) OR (r.kind = 'reply' AND r.trigger_comment_id IS ? AND r.request_id = ?)) ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .bind(
      u.userId,
      input.threadId,
      input.kind,
      input.triggerCommentId,
      input.requestId,
    )
    .first<TurnRow>()
  if (
    row &&
    (!['failed', 'stale'].includes(row.status) ||
      row.id === attempt ||
      row.logical_request_id !== input.requestId)
  )
    return getTurn(p, u, row.id)
  const thread = await p.db
    .prepare('SELECT 1 FROM owned_threads WHERE id = ? AND owner_id = ?')
    .bind(input.threadId, u.userId)
    .first()
  if (!thread) notFound()
  const settings = await p.db
    .prepare(
      'SELECT ai_enabled, consent_at FROM account_settings WHERE owner_id = ?',
    )
    .bind(u.userId)
    .first<{ ai_enabled: number; consent_at: string | null }>()
  if (!settings?.ai_enabled || !settings.consent_at)
    throw new ApiError(
      403,
      'AI_DISABLED',
      'Enable AI and acknowledge consent first',
    )
  const counts = await p.db
    .prepare(
      "SELECT (SELECT count(*) FROM ai_allowances WHERE owner_id = ? AND utc_day = ? AND kind = ?) AS daily, (SELECT count(*) FROM ai_turns WHERE owner_id = ? AND status IN ('reserved','running')) AS active, (SELECT COALESCE(sum(reserved_micros), 0) FROM ai_usage WHERE utc_day = ?) AS spend",
    )
    .bind(u.userId, day, input.kind, u.userId, day)
    .first<{ daily: number; active: number; spend: number }>()
  if (
    counts &&
    ((!row && counts.daily >= (input.kind === 'opening' ? 5 : 30)) ||
      counts.spend + worst > ceiling)
  )
    throw new ApiError(429, 'AI_LIMIT_REACHED', 'Daily AI limit reached')
  throw new ApiError(409, 'AI_BUSY', 'A generation is already active')
}
export async function cancelTurn(
  p: Platform,
  u: UserContext,
  id: string,
): Promise<TurnState> {
  requireVerified(u)
  uuid(id)
  await p.db
    .prepare(
      "UPDATE ai_turns SET status = 'cancelled', error_code = 'CANCELLED' WHERE id = ? AND owner_id = ? AND status IN ('reserved','running')",
    )
    .bind(id, u.userId)
    .run()
  return getTurn(p, u, id)
}
// Task 8 must use this predicate inside the same D1 batch as every generated
// comment/memory write, keyed by the attempt ID; a prior read is not a fence.
export const finalizationFence = `status IN ('reserved','running') AND lease_until > ? AND EXISTS (SELECT 1 FROM owned_threads t JOIN account_settings s ON s.owner_id = t.owner_id WHERE t.id = ai_turns.thread_id AND t.owner_id = ai_turns.owner_id AND t.revision = ai_turns.thread_revision AND t.source_revision = ai_turns.source_revision AND s.ai_enabled = 1 AND s.consent_at IS NOT NULL AND s.settings_epoch = ai_turns.settings_epoch AND s.memory_epoch = ai_turns.memory_epoch)`
export async function settleTurn(
  p: Platform,
  u: UserContext,
  id: string,
  usage: ProviderUsage,
  outcome: 'complete' | 'failed' | 'stale',
): Promise<void> {
  requireVerified(u)
  uuid(id)
  if (!p.env.aiEnabled)
    throw new ApiError(409, 'TURN_STALE', 'AI generation is disabled')
  if (
    ![
      usage.inputTokens,
      usage.outputTokens,
      ...(usage.estimatedCostMicros === null
        ? []
        : [usage.estimatedCostMicros]),
    ].every((x) => Number.isSafeInteger(x) && x >= 0)
  )
    throw new ApiError(400, 'INVALID_USAGE', 'Invalid provider usage')
  const now = new Date().toISOString()
  const result = await p.db.batch([
    p.db
      .prepare(
        `UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, estimated_cost_micros = ?, reserved_micros = MAX(reserved_micros, COALESCE(?, 0)) WHERE turn_id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM ai_turns WHERE id = ? AND owner_id = ? AND ${finalizationFence})`,
      )
      .bind(
        usage.inputTokens,
        usage.outputTokens,
        usage.estimatedCostMicros,
        usage.estimatedCostMicros,
        id,
        u.userId,
        id,
        u.userId,
        now,
      ),
    p.db
      .prepare(
        `UPDATE ai_turns SET status = ? WHERE id = ? AND owner_id = ? AND ${finalizationFence}`,
      )
      .bind(outcome, id, u.userId, now),
  ])
  if (result[1].meta.changes !== 1)
    throw new ApiError(409, 'TURN_STALE', 'Generation is no longer active')
}
