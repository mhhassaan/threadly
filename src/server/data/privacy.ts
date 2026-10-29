import type { Platform } from '../platform'
import { ApiError, type UserContext } from '../../lib/account-thread'
import { requireVerified, getSnapshot, notFound } from './threads'
import { uuid } from './validation'
import { getCast } from '../discussion/cast'
import { createAuth } from '../auth/auth'
const regularIds = getCast('20000000-0000-4000-8000-000000000001')
  .filter((p) => p.kind === 'regular')
  .map((p) => p.id)
export function validatePersona(id: string) {
  if (!regularIds.includes(id))
    throw new ApiError(400, 'INVALID_INPUT', 'Choose a recurring participant')
}
const cancel = (p: Platform, u: UserContext) =>
  p.db
    .prepare(
      "UPDATE ai_turns SET status='cancelled',error_code='MEMORY_CHANGED' WHERE owner_id=? AND status IN ('reserved','running')",
    )
    .bind(u.userId)
export async function clearMemory(
  p: Platform,
  u: UserContext,
  personaId?: string,
): Promise<void> {
  requireVerified(u)
  if (personaId !== undefined) validatePersona(personaId)
  const statements = [
    p.db
      .prepare(
        'INSERT INTO account_settings(owner_id) VALUES (?) ON CONFLICT DO NOTHING',
      )
      .bind(u.userId),
  ]
  if (personaId) {
    statements.push(
      p.db
        .prepare(
          "INSERT INTO memory_resets(owner_id,persona_id,reset_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(owner_id,persona_id) DO UPDATE SET reset_at=excluded.reset_at",
        )
        .bind(u.userId, personaId),
    )
  } else {
    statements.push(
      p.db
        .prepare(
          "UPDATE account_settings SET memory_reset_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=?",
        )
        .bind(u.userId),
    )
  }
  statements.push(
    p.db
      .prepare(
        'UPDATE account_settings SET memory_epoch=memory_epoch+1 WHERE owner_id=?',
      )
      .bind(u.userId),
    cancel(p, u),
  )
  statements.push(
    p.db
      .prepare(
        'DELETE FROM participant_memories WHERE owner_id=?' +
          (personaId ? ' AND persona_id=?' : ''),
      )
      .bind(u.userId, ...(personaId ? [personaId] : [])),
  )
  if (personaId)
    statements.push(
      p.db
        .prepare(
          'DELETE FROM participant_memories WHERE owner_id=? AND epoch <> (SELECT memory_epoch-1 FROM account_settings WHERE owner_id=?)',
        )
        .bind(u.userId, u.userId),
    )
  if (personaId)
    statements.push(
      p.db
        .prepare(
          'UPDATE participant_memories SET epoch=(SELECT memory_epoch FROM account_settings WHERE owner_id=?) WHERE owner_id=?',
        )
        .bind(u.userId, u.userId),
    )
  await p.db.batch(statements)
}
export async function deleteMemoryItem(
  p: Platform,
  u: UserContext,
  id: string,
): Promise<void> {
  requireVerified(u)
  uuid(id)
  const results = await p.db.batch([
    p.db
      .prepare(
        'INSERT INTO memory_suppressions(owner_id,persona_id,comment_id) SELECT m.owner_id,m.persona_id,e.comment_id FROM participant_memories m JOIN memory_evidence e ON e.memory_id=m.id WHERE m.id=? AND m.owner_id=? ON CONFLICT DO NOTHING',
      )
      .bind(id, u.userId),
    p.db
      .prepare(
        'UPDATE account_settings SET memory_epoch=memory_epoch+1 WHERE owner_id=? AND EXISTS(SELECT 1 FROM participant_memories WHERE id=? AND owner_id=?)',
      )
      .bind(u.userId, id, u.userId),
    p.db
      .prepare(
        "UPDATE ai_turns SET status='cancelled',error_code='MEMORY_CHANGED' WHERE owner_id=? AND status IN ('reserved','running') AND EXISTS(SELECT 1 FROM participant_memories WHERE id=? AND owner_id=?)",
      )
      .bind(u.userId, id, u.userId),
    p.db
      .prepare('DELETE FROM participant_memories WHERE id=? AND owner_id=?')
      .bind(id, u.userId),
    p.db
      .prepare(
        'UPDATE participant_memories SET epoch=(SELECT memory_epoch FROM account_settings WHERE owner_id=?) WHERE owner_id=?',
      )
      .bind(u.userId, u.userId),
  ])
  if (!results[3].meta.changes)
    throw new ApiError(404, 'NOT_FOUND', 'Memory not found')
}
export async function deleteConversation(
  p: Platform,
  u: UserContext,
  threadId: string,
  postId: string,
): Promise<void> {
  requireVerified(u)
  uuid(threadId)
  uuid(postId)
  const snapshot = await getSnapshot(p, u, threadId)
  if (!snapshot.thread.posts.some((p) => p.id === postId)) notFound()
  await p.db.batch([
    p.db
      .prepare(
        'UPDATE owned_threads SET opening_blocked=1,revision=revision+1 WHERE id=? AND owner_id=?',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        "UPDATE ai_turns SET status='cancelled',error_code='DISCUSSION_DELETED' WHERE thread_id=? AND owner_id=? AND status IN ('reserved','running')",
      )
      .bind(threadId, u.userId),
    // All turn identities are metadata only; deleted human trigger IDs are scrubbed.
    p.db
      .prepare(
        'UPDATE ai_requests SET trigger_comment_id=NULL WHERE thread_id=? AND owner_id=? AND trigger_comment_id IN (SELECT id FROM comments WHERE post_id=? AND owner_id=?)',
      )
      .bind(threadId, u.userId, postId, u.userId),
    p.db
      .prepare(
        'DELETE FROM ai_request_cancellations WHERE thread_id=? AND owner_id=? AND trigger_comment_id IN (SELECT id FROM comments WHERE post_id=? AND owner_id=?)',
      )
      .bind(threadId, u.userId, postId, u.userId),
    p.db
      .prepare(
        'DELETE FROM comments WHERE post_id=? AND thread_id=? AND owner_id=?',
      )
      .bind(postId, threadId, u.userId),
  ])
}
export async function restartDiscussion(
  p: Platform,
  u: UserContext,
  threadId: string,
): Promise<void> {
  requireVerified(u)
  uuid(threadId)
  // Explicit user action only. Remove opening metadata so the existing intent can
  // start once, while keeping anonymous spend and consumed daily allowances.
  const results = await p.db.batch([
    // FK deletion removes old attempts/admissions, so retain every admitted
    // opaque identity before removing its canonical row. A late operation must
    // never become an unseen alias of the replacement opening.
    p.db
      .prepare(
        `INSERT INTO ai_request_cancellations (owner_id,request_id,thread_id,kind,trigger_comment_id,source_revision)
      SELECT r.owner_id,r.request_id,r.thread_id,r.kind,NULL,r.source_revision FROM ai_requests r JOIN owned_threads t ON t.id=r.thread_id AND t.owner_id=r.owner_id
      WHERE r.owner_id=? AND r.thread_id=? AND r.kind='opening' AND t.opening_blocked=1
      UNION
      SELECT m.owner_id,m.request_id,r.thread_id,r.kind,NULL,r.source_revision FROM ai_opening_admissions m JOIN ai_requests r ON r.id=m.canonical_id AND r.owner_id=m.owner_id JOIN owned_threads t ON t.id=r.thread_id AND t.owner_id=r.owner_id
      WHERE m.owner_id=? AND r.thread_id=? AND r.kind='opening' AND t.opening_blocked=1
      ON CONFLICT DO NOTHING`,
      )
      .bind(u.userId, threadId, u.userId, threadId),
    p.db
      .prepare(
        "DELETE FROM ai_requests WHERE owner_id=? AND thread_id=? AND kind='opening' AND EXISTS(SELECT 1 FROM owned_threads WHERE id=? AND owner_id=? AND opening_blocked=1)",
      )
      .bind(u.userId, threadId, threadId, u.userId),
    p.db
      .prepare(
        'UPDATE owned_threads SET opening_blocked=0 WHERE id=? AND owner_id=?',
      )
      .bind(threadId, u.userId),
  ])
  if (!results[2].meta.changes) notFound()
}
export async function deleteAccount(
  p: Platform,
  u: UserContext,
  request: Request,
): Promise<void> {
  requireVerified(u)
  let password: unknown
  try {
    const body = (await request.json()) as Record<string, unknown>
    if (Object.keys(body).some((k) => k !== 'password')) throw new Error()
    password = body.password
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', 'Enter your current password')
  }
  if (typeof password !== 'string' || !password.length || password.length > 128)
    throw new ApiError(400, 'INVALID_INPUT', 'Enter your current password')
  const key =
    'account-delete:' + u.userId + ':' + Math.floor(Date.now() / 60000)
  const attempts = await p.db
    .prepare(
      'INSERT INTO rate_limit(id,key,count,last_request) VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1,last_request=excluded.last_request RETURNING count',
    )
    .bind(crypto.randomUUID(), key, Date.now())
    .first<{ count: number }>()
  if (!attempts || attempts.count > 5)
    throw new ApiError(
      429,
      'REAUTH_LIMIT',
      'Too many attempts. Wait a minute and try again',
    )
  const auth = createAuth(p)
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session || session.user.id !== u.userId)
    throw new ApiError(
      401,
      'UNAUTHORIZED',
      'Sign in again to delete your account',
    )
  const receipt = await p.db
    .prepare(
      `SELECT a.id,a.password,u.credential_generation FROM account a JOIN user u ON u.id=a.user_id JOIN session s ON s.user_id=u.id WHERE u.id=? AND a.provider_id='credential' AND s.id=? AND s.expires_at>? AND s.credential_generation=u.credential_generation`,
    )
    .bind(u.userId, session.session.id, Date.now())
    .first<{ id: string; password: string; credential_generation: number }>()
  if (
    !receipt ||
    !(await (
      await auth.$context
    ).password.verify({ hash: receipt.password, password }))
  )
    throw new ApiError(
      403,
      'REAUTH_REQUIRED',
      'Your current password was not accepted',
    )
  // Password verification is asynchronous. Check the exact hash, generation and
  // still-live session again in the atomic delete statement (reset/revocation fence).
  const result = await p.db
    .prepare(
      'DELETE FROM user WHERE id=? AND credential_generation=? AND EXISTS(SELECT 1 FROM account WHERE id=? AND user_id=user.id AND password=?) AND EXISTS(SELECT 1 FROM session WHERE id=? AND user_id=user.id AND credential_generation=user.credential_generation AND expires_at>?)',
    )
    .bind(
      u.userId,
      receipt.credential_generation,
      receipt.id,
      receipt.password,
      session.session.id,
      Date.now(),
    )
    .run()
  if (!result.meta.changes)
    throw new ApiError(
      409,
      'REAUTH_CHANGED',
      'Your session changed. Sign in again before deleting your account',
    )
}
