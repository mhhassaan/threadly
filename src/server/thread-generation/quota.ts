import type { Platform } from '../platform'
import { ApiError, type UserContext } from '../../lib/account-thread'
import type { GenerationQuota } from '../../lib/thread-generation'
import { accountPrincipal, cookieGuest } from './identity'
import {
  assertPrincipal,
  currentJobFence,
  digest,
  key,
  type Principal,
} from './policy'

/** Bounded, read-safe housekeeping. Cost reservations are never released here. */
export async function retireGenerationJobs(p: Platform, principal?: Principal) {
  const now = new Date().toISOString()
  await p.db.batch([
    p.db
      .prepare(
        `UPDATE generation_jobs SET status='stale',phase=NULL,error_code='LEASE_EXPIRED',input_json=NULL,result_json=NULL WHERE id IN (SELECT id FROM generation_jobs WHERE status IN ('reserved','running') AND NOT (${currentJobFence}) AND (? IS NULL OR principal_key=?) LIMIT 100)`,
      )
      .bind(
        principal ? key(principal) : null,
        principal ? key(principal) : null,
      ),
    p.db.prepare(
      "UPDATE generation_debits SET state='released' WHERE state='reserved' AND job_id IN (SELECT id FROM generation_jobs WHERE status IN ('failed','cancelled','stale'))",
    ),
    p.db
      .prepare(
        'UPDATE generation_jobs SET input_json=NULL,result_json=NULL WHERE id IN (SELECT id FROM generation_jobs WHERE expires_at<=? AND (input_json IS NOT NULL OR result_json IS NOT NULL) LIMIT 100)',
      )
      .bind(now),
  ])
}
export async function getGenerationQuota(
  p: Platform,
  principal: Principal,
): Promise<GenerationQuota> {
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  const day = new Date().toISOString().slice(0, 10)
  const counts = await p.db
    .prepare(
      `SELECT COALESCE(sum(state='used'),0) used,COALESCE(sum(state='reserved'),0) reserved FROM generation_debits WHERE principal_key=? AND (?='guest' OR utc_day=?)`,
    )
    .bind(key(principal), principal.kind, day)
    .first<{ used: number; reserved: number }>()
  const limit = principal.kind === 'guest' ? 2 : 10
  return {
    kind: principal.kind,
    limit,
    used: counts?.used ?? 0,
    reserved: counts?.reserved ?? 0,
    remaining: Math.max(
      0,
      limit - (counts?.used ?? 0) - (counts?.reserved ?? 0),
    ),
    resetAt:
      principal.kind === 'guest'
        ? null
        : new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString(),
  }
}
/** Called on server identity resolution as well as the explicit sign-in claim endpoint. */
export async function claimForPrincipal(
  p: Platform,
  principal: Extract<Principal, { kind: 'account' }>,
  request: Request,
): Promise<void> {
  await assertPrincipal(p, principal)
  const guestId = await cookieGuest(p, request)
  if (!guestId) return
  const marker = crypto.randomUUID(),
    day = new Date().toISOString().slice(0, 10),
    accountKey = await digest(key(principal))
  const owner = principal.user.userId
  await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO generation_claims(id,guest_id,account_key,owner_id,utc_day) SELECT ?,g.id,?,?,? FROM generation_guests g WHERE g.id=? AND EXISTS(SELECT 1 FROM user u JOIN session s ON s.user_id=u.id WHERE u.id=? AND u.email_verified=1 AND u.credential_generation=? AND s.id=? AND s.credential_generation=u.credential_generation AND s.expires_at>?) ON CONFLICT DO NOTHING`,
      )
      .bind(
        marker,
        accountKey,
        owner,
        day,
        guestId,
        owner,
        principal.credentialGeneration,
        principal.sessionId,
        Date.now(),
      ),
    p.db
      .prepare(
        "UPDATE generation_jobs SET status='cancelled',phase=NULL,error_code='GUEST_CLAIMED',input_json=NULL,result_json=NULL WHERE guest_id=? AND status IN ('reserved','running') AND EXISTS(SELECT 1 FROM generation_claims WHERE id=?)",
      )
      .bind(guestId, marker),
    p.db
      .prepare(
        "UPDATE generation_debits SET state='released' WHERE state='reserved' AND job_id IN(SELECT id FROM generation_jobs WHERE guest_id=? AND status='cancelled') AND EXISTS(SELECT 1 FROM generation_claims WHERE id=?)",
      )
      .bind(guestId, marker),
    p.db
      .prepare(
        'UPDATE generation_jobs SET owner_id=? WHERE guest_id=? AND EXISTS(SELECT 1 FROM generation_claims WHERE id=?)',
      )
      .bind(owner, guestId, marker),
    p.db
      .prepare(
        "UPDATE generation_debits SET principal_key=?,owner_id=?,utc_day=? WHERE state='used' AND principal_key=? AND EXISTS(SELECT 1 FROM generation_claims WHERE id=?)",
      )
      .bind(key(principal), owner, day, 'guest:' + guestId, marker),
  ])
}
export async function claimGuestUsage(
  p: Platform,
  user: UserContext,
  request: Request,
): Promise<GenerationQuota> {
  const principal = await accountPrincipal(p, request)
  if (!principal || principal.user.userId !== user.userId)
    throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue')
  await claimForPrincipal(p, principal, request)
  return getGenerationQuota(p, principal)
}
