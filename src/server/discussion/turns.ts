import {
  ApiError,
  type UserContext,
  type TurnInput,
  type TurnState,
  type LogicalTurnStatus,
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
async function assertAdmissionIdentity(
  p: Platform,
  u: UserContext,
  input: TurnInput,
) {
  const conflict = await p.db
    .prepare(
      `SELECT 1 FROM (
    SELECT thread_id, kind, trigger_comment_id FROM ai_requests WHERE owner_id = ? AND request_id = ?
    UNION ALL SELECT r.thread_id, r.kind, r.trigger_comment_id FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ?
    UNION ALL SELECT thread_id, kind, trigger_comment_id FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?
  ) WHERE thread_id <> ? OR kind <> ? OR (kind = 'reply' AND trigger_comment_id IS NOT ?) LIMIT 1`,
    )
    .bind(
      u.userId,
      input.requestId,
      u.userId,
      input.requestId,
      u.userId,
      input.requestId,
      input.threadId,
      input.kind,
      input.triggerCommentId,
    )
    .first()
  if (conflict)
    throw new ApiError(
      409,
      'REQUEST_CONFLICT',
      'Request identity does not match',
    )
}
export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  estimatedCostMicros: number | null
}
async function validateLogicalInput(
  p: Platform,
  u: UserContext,
  input: TurnInput,
) {
  requireVerified(u)
  uuid(input.requestId)
  uuid(input.threadId)
  if (input.kind !== 'opening' && input.kind !== 'reply')
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid turn kind')
  if (
    (input.kind === 'opening' && input.triggerCommentId !== null) ||
    (input.kind === 'reply' && input.triggerCommentId === null)
  )
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid turn trigger')
  if (input.triggerCommentId !== null) uuid(input.triggerCommentId)
  const thread = await p.db
    .prepare(
      'SELECT source_revision FROM owned_threads WHERE id = ? AND owner_id = ?',
    )
    .bind(input.threadId, u.userId)
    .first<{ source_revision: number }>()
  if (!thread) notFound()
  if (
    input.triggerCommentId !== null &&
    !(await p.db
      .prepare(
        "SELECT 1 FROM comments WHERE id = ? AND thread_id = ? AND owner_id = ? AND author_kind = 'human'",
      )
      .bind(input.triggerCommentId, input.threadId, u.userId)
      .first())
  )
    notFound()
  return thread
}
export async function getLogicalTurn(
  p: Platform,
  u: UserContext,
  input: TurnInput,
): Promise<LogicalTurnStatus> {
  const thread = await validateLogicalInput(p, u, input)
  const conflict = await p.db
    .prepare(
      `SELECT 1 FROM (SELECT thread_id, kind, trigger_comment_id, source_revision FROM ai_requests WHERE owner_id = ? AND request_id = ? UNION ALL SELECT thread_id, kind, trigger_comment_id, source_revision FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ? UNION ALL SELECT r.thread_id, r.kind, r.trigger_comment_id, r.source_revision FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ?) WHERE thread_id <> ? OR kind <> ? OR trigger_comment_id IS NOT ? OR source_revision <> ? LIMIT 1`,
    )
    .bind(
      u.userId,
      input.requestId,
      u.userId,
      input.requestId,
      u.userId,
      input.requestId,
      input.threadId,
      input.kind,
      input.triggerCommentId,
      thread.source_revision,
    )
    .first()
  if (conflict)
    throw new ApiError(
      409,
      'REQUEST_CONFLICT',
      'Request identity does not match',
    )
  if (input.kind === 'opening') {
    const admission = await p.db
      .prepare(
        `SELECT m.turn_id, r.thread_id, r.source_revision FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ?`,
      )
      .bind(u.userId, input.requestId)
      .first<{
        turn_id: string | null
        thread_id: string
        source_revision: number
      }>()
    if (admission) {
      if (
        admission.thread_id !== input.threadId ||
        admission.source_revision !== thread.source_revision
      )
        throw new ApiError(
          409,
          'REQUEST_CONFLICT',
          'Request identity does not match',
        )
      const turn = admission.turn_id
        ? await getTurn(p, u, admission.turn_id)
        : null
      const cancelled =
        !turn &&
        !!(await p.db
          .prepare(
            'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?',
          )
          .bind(u.userId, input.requestId)
          .first())
      return { turn, cancelled: turn ? turn.status === 'cancelled' : cancelled }
    }
    const cancelled = await p.db
      .prepare(
        'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?',
      )
      .bind(u.userId, input.requestId)
      .first()
    if (cancelled) return { turn: null, cancelled: true }
  }
  const row = await p.db
    .prepare(
      `SELECT a.id FROM ai_requests r JOIN ai_turns a ON a.request_id = r.id WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND ((r.kind = 'opening' AND r.source_revision = ?) OR (r.kind = 'reply' AND r.request_id = ? AND r.trigger_comment_id IS ?)) ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .bind(
      u.userId,
      input.threadId,
      input.kind,
      thread.source_revision,
      input.requestId,
      input.triggerCommentId,
    )
    .first<{ id: string }>()
  const turn = row ? await getTurn(p, u, row.id) : null
  const tombstone = await p.db
    .prepare(
      'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?',
    )
    .bind(u.userId, input.requestId)
    .first()
  return { turn, cancelled: turn ? turn.status === 'cancelled' : !!tombstone }
}
export async function cancelLogicalTurn(
  p: Platform,
  u: UserContext,
  input: TurnInput,
): Promise<LogicalTurnStatus> {
  const thread = await validateLogicalInput(p, u, input)
  // Validate existing request identities before attaching a previously unseen alias.
  await getLogicalTurn(p, u, input)
  if (input.kind === 'opening') {
    await p.db.batch([
      p.db
        .prepare(
          `INSERT INTO ai_opening_admissions (owner_id, request_id, canonical_id, turn_id) SELECT r.owner_id, ?, r.id, (SELECT a.id FROM ai_turns a WHERE a.request_id = r.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) FROM ai_requests r WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = 'opening' AND r.source_revision = ? AND NOT EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = r.owner_id AND c.request_id = ?) AND NOT EXISTS (SELECT 1 FROM ai_requests other WHERE other.owner_id = r.owner_id AND other.request_id = ? AND other.id <> r.id) ON CONFLICT DO NOTHING`,
        )
        .bind(
          input.requestId,
          u.userId,
          input.threadId,
          thread.source_revision,
          input.requestId,
          input.requestId,
        ),
      p.db
        .prepare(
          `INSERT INTO ai_request_cancellations (owner_id, request_id, thread_id, kind, trigger_comment_id, source_revision) SELECT ?, ?, ?, 'opening', NULL, ? WHERE NOT EXISTS (SELECT 1 FROM ai_requests r WHERE r.owner_id = ? AND r.request_id = ? AND (r.thread_id <> ? OR r.kind <> 'opening' OR r.source_revision <> ?)) AND NOT EXISTS (SELECT 1 FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ? AND (r.thread_id <> ? OR r.source_revision <> ?)) ON CONFLICT DO NOTHING`,
        )
        .bind(
          u.userId,
          input.requestId,
          input.threadId,
          thread.source_revision,
          u.userId,
          input.requestId,
          input.threadId,
          thread.source_revision,
          u.userId,
          input.requestId,
          input.threadId,
          thread.source_revision,
        ),
      p.db
        .prepare(
          `UPDATE ai_turns SET status = 'cancelled', error_code = 'CANCELLED' WHERE owner_id = ? AND status IN ('reserved','running') AND id = (SELECT m.turn_id FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ? AND r.thread_id = ? AND r.source_revision = ?) AND EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = ? AND c.request_id = ? AND c.thread_id = ? AND c.kind = 'opening' AND c.source_revision = ?)`,
        )
        .bind(
          u.userId,
          u.userId,
          input.requestId,
          input.threadId,
          thread.source_revision,
          u.userId,
          input.requestId,
          input.threadId,
          thread.source_revision,
        ),
    ])
    return getLogicalTurn(p, u, input)
  }
  await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO ai_request_cancellations (owner_id, request_id, thread_id, kind, trigger_comment_id, source_revision) SELECT t.owner_id, ?, t.id, ?, ?, t.source_revision FROM owned_threads t WHERE t.owner_id = ? AND t.id = ? AND NOT EXISTS (SELECT 1 FROM ai_requests r WHERE r.owner_id = t.owner_id AND r.request_id = ? AND (r.thread_id <> t.id OR r.kind <> ? OR r.trigger_comment_id IS NOT ? OR r.source_revision <> t.source_revision)) AND NOT EXISTS (SELECT 1 FROM ai_opening_admissions m WHERE m.owner_id = t.owner_id AND m.request_id = ?) ON CONFLICT DO NOTHING`,
      )
      .bind(
        input.requestId,
        input.kind,
        input.triggerCommentId,
        u.userId,
        input.threadId,
        input.requestId,
        input.kind,
        input.triggerCommentId,
        input.requestId,
      ),
    p.db
      .prepare(
        `UPDATE ai_turns SET status = 'cancelled', error_code = 'CANCELLED' WHERE owner_id = ? AND status IN ('reserved','running') AND EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = ? AND c.request_id = ? AND c.thread_id = ? AND c.kind = ? AND c.trigger_comment_id IS ? AND c.source_revision = ?) AND request_id IN (SELECT r.id FROM ai_requests r WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND ((r.kind = 'opening' AND r.source_revision = ?) OR (r.kind = 'reply' AND r.request_id = ? AND r.trigger_comment_id IS ?)))`,
      )
      .bind(
        u.userId,
        u.userId,
        input.requestId,
        input.threadId,
        input.kind,
        input.triggerCommentId,
        thread.source_revision,
        u.userId,
        input.threadId,
        input.kind,
        thread.source_revision,
        input.requestId,
        input.triggerCommentId,
      ),
  ])
  const identity = await p.db
    .prepare(
      'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ? AND thread_id = ? AND kind = ? AND trigger_comment_id IS ? AND source_revision = ?',
    )
    .bind(
      u.userId,
      input.requestId,
      input.threadId,
      input.kind,
      input.triggerCommentId,
      thread.source_revision,
    )
    .first()
  if (!identity)
    throw new ApiError(
      409,
      'REQUEST_CONFLICT',
      'Request identity does not match',
    )
  const row = await p.db
    .prepare(
      `SELECT a.id FROM ai_requests r JOIN ai_turns a ON a.request_id = r.id WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND ((r.kind = 'opening' AND r.source_revision = ?) OR (r.kind = 'reply' AND r.request_id = ? AND r.trigger_comment_id IS ?)) ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .bind(
      u.userId,
      input.threadId,
      input.kind,
      thread.source_revision,
      input.requestId,
      input.triggerCommentId,
    )
    .first<{ id: string }>()
  const turn = row ? await getTurn(p, u, row.id) : null
  return { turn, cancelled: !turn || turn.status === 'cancelled' }
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
  await assertAdmissionIdentity(p, u, input)
  const alias = await p.db
    .prepare(
      `SELECT r.thread_id, r.source_revision, m.turn_id FROM ai_opening_admissions m JOIN ai_requests r ON r.id = m.canonical_id AND r.owner_id = m.owner_id WHERE m.owner_id = ? AND m.request_id = ?`,
    )
    .bind(u.userId, input.requestId)
    .first<{
      thread_id: string
      source_revision: number
      turn_id: string | null
    }>()
  if (alias && (alias.thread_id !== input.threadId || input.kind !== 'opening'))
    throw new ApiError(
      409,
      'REQUEST_CONFLICT',
      'Request identity does not match',
    )
  const tombstone = await p.db
    .prepare(
      'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?',
    )
    .bind(u.userId, input.requestId)
    .first()
  if (tombstone && !alias && input.kind === 'opening')
    throw new ApiError(
      409,
      'TURN_CANCELLED',
      'Discussion request was cancelled',
    )

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
      SELECT ?, ?, ?, t.id, ?, ?, t.source_revision, ? FROM owned_threads t WHERE t.id = ? AND t.owner_id = ? AND NOT EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = t.owner_id AND c.request_id = ?) AND NOT EXISTS (SELECT 1 FROM ai_opening_admissions m WHERE m.owner_id = t.owner_id AND m.request_id = ?) AND ${eligibility}
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
        input.requestId,
        input.requestId,
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
        `INSERT INTO ai_opening_admissions (owner_id, request_id, canonical_id, turn_id)
      SELECT r.owner_id, ?, r.id, (SELECT CASE WHEN a.status = 'cancelled' THEN NULL ELSE a.id END FROM ai_turns a WHERE a.request_id = r.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1)
      FROM ai_requests r JOIN owned_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = 'opening' AND r.source_revision = t.source_revision AND (r.request_id = ? OR COALESCE((SELECT a.status FROM ai_turns a WHERE a.request_id = r.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1), '') NOT IN ('failed','stale')) AND NOT EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = r.owner_id AND c.request_id = ?) AND NOT EXISTS (SELECT 1 FROM ai_requests other WHERE other.owner_id = r.owner_id AND other.request_id = ? AND other.id <> r.id) ON CONFLICT DO NOTHING`,
      )
      .bind(
        input.requestId,
        u.userId,
        input.threadId,
        input.requestId,
        input.requestId,
        input.requestId,
      ),
    p.db
      .prepare(
        `INSERT INTO ai_turns (id, request_id, owner_id, thread_id, status, lease_until, thread_revision, source_revision, settings_epoch, memory_epoch, created_at)
      SELECT ?, r.id, r.owner_id, r.thread_id, 'reserved', ?, t.revision, t.source_revision, s.settings_epoch, s.memory_epoch, ? FROM ai_requests r JOIN owned_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id JOIN account_settings s ON s.owner_id = r.owner_id
      WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND (r.request_id = ? OR (r.kind = 'opening' AND EXISTS (SELECT 1 FROM ai_opening_admissions m WHERE m.canonical_id = r.id AND m.owner_id = r.owner_id AND m.request_id = ?))) AND r.source_revision = t.source_revision AND (r.kind = 'opening' OR r.trigger_comment_id IS ?) AND ${eligibility}
      AND NOT EXISTS (SELECT 1 FROM ai_request_cancellations c WHERE c.owner_id = r.owner_id AND c.request_id = ?)
      AND NOT EXISTS (SELECT 1 FROM ai_turns prior WHERE prior.request_id = r.id AND prior.status NOT IN ('failed','stale','cancelled'))
      AND (NOT EXISTS (SELECT 1 FROM ai_turns prior WHERE prior.request_id = r.id AND prior.status = 'cancelled') OR (r.kind = 'opening' AND EXISTS (SELECT 1 FROM ai_opening_admissions m WHERE m.owner_id = r.owner_id AND m.canonical_id = r.id AND m.request_id = ? AND (m.turn_id IS NULL OR EXISTS (SELECT 1 FROM ai_turns retry WHERE retry.id = m.turn_id AND retry.status IN ('failed','stale'))))))
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
        input.requestId,
        input.triggerCommentId,
        ...bindings,
        input.requestId,
        input.requestId,
      ),
    p.db
      .prepare(
        `UPDATE ai_opening_admissions SET turn_id = ? WHERE owner_id = ? AND request_id = ? AND EXISTS (SELECT 1 FROM ai_turns WHERE id = ? AND request_id = ai_opening_admissions.canonical_id)`,
      )
      .bind(attempt, u.userId, input.requestId, attempt),
    p.db
      .prepare(
        'INSERT INTO ai_usage (turn_id, owner_id, utc_day, reserved_micros) SELECT id, owner_id, ?, ? FROM ai_turns WHERE id = ?',
      )
      .bind(day, worst, attempt),
  ]
  await p.db.batch(statements)
  await assertAdmissionIdentity(p, u, input)
  const row = await p.db
    .prepare(
      `SELECT a.id, a.status, a.error_code, r.request_id AS logical_request_id FROM ai_requests r JOIN ai_turns a ON a.request_id = r.id JOIN owned_threads t ON t.id = r.thread_id AND t.owner_id = r.owner_id WHERE r.owner_id = ? AND r.thread_id = ? AND r.kind = ? AND ((r.kind = 'opening' AND r.source_revision = t.source_revision) OR (r.kind = 'reply' AND r.trigger_comment_id IS ? AND r.request_id = ?)) AND (r.kind <> 'opening' OR a.id = COALESCE((SELECT m.turn_id FROM ai_opening_admissions m WHERE m.owner_id = r.owner_id AND m.request_id = ?), a.id)) ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    )
    .bind(
      u.userId,
      input.threadId,
      input.kind,
      input.triggerCommentId,
      input.requestId,
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
  const cancelled = await p.db
    .prepare(
      'SELECT 1 FROM ai_request_cancellations WHERE owner_id = ? AND request_id = ?',
    )
    .bind(u.userId, input.requestId)
    .first()
  if (cancelled)
    throw new ApiError(
      409,
      'TURN_CANCELLED',
      'Discussion request was cancelled',
    )
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
export const finalizationFence = `status IN ('reserved','running') AND lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND EXISTS (SELECT 1 FROM owned_threads t JOIN account_settings s ON s.owner_id = t.owner_id WHERE t.id = ai_turns.thread_id AND t.owner_id = ai_turns.owner_id AND t.revision = ai_turns.thread_revision AND t.source_revision = ai_turns.source_revision AND s.ai_enabled = 1 AND s.consent_at IS NOT NULL AND s.settings_epoch = ai_turns.settings_epoch AND s.memory_epoch = ai_turns.memory_epoch)`
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
  const marker = crypto.randomUUID()
  const result = await p.db.batch([
    p.db
      .prepare(
        `UPDATE ai_turns SET status = ?, error_code = ? WHERE id = ? AND owner_id = ? AND ${finalizationFence}`,
      )
      .bind(outcome, marker, id, u.userId),
    p.db
      .prepare(
        `UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, estimated_cost_micros = ?, reserved_micros = MAX(reserved_micros, COALESCE(?, 0)) WHERE turn_id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM ai_turns WHERE id = ? AND owner_id = ? AND error_code = ?)`,
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
        marker,
      ),
    p.db
      .prepare(
        `UPDATE ai_turns SET error_code = NULL WHERE id = ? AND owner_id = ? AND error_code = ?`,
      )
      .bind(id, u.userId, marker),
  ])
  if (result[0].meta.changes !== 1)
    throw new ApiError(409, 'TURN_STALE', 'Generation is no longer active')
}
