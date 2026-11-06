import type { Platform } from '../platform'
import { ApiError } from '../../lib/account-thread'
import type {
  GenerationInput,
  GenerationStatus,
} from '../../lib/thread-generation'
import { validRecord, type ThreadRecord } from '../../lib/thread'
import { initializeAccountSettings } from '../data/settings'
import { retireGenerationJobs } from './quota'
import {
  assertPrincipal,
  currentJobFence,
  digest,
  generationBudget,
  generationLeaseMs,
  generationReservationMicros,
  key,
  normalizeInput,
  refinedReservation,
  type Principal,
} from './policy'

type JobRow = {
  id: string
  status: GenerationStatus['status']
  phase: GenerationStatus['phase']
  error_code: string | null
  result_json: string | null
  fingerprint: string
  record_id: string
}
const dto = (row: JobRow): GenerationStatus => ({
  id: row.id,
  status: row.status,
  phase: row.phase,
  ...(row.result_json ? { record: JSON.parse(row.result_json) } : {}),
  ...(row.error_code
    ? { errorCode: row.error_code }
    : row.status === 'complete' && !row.result_json
      ? { errorCode: 'RESULT_EXPIRED' }
      : {}),
})
async function ownedJob(p: Platform, principal: Principal, id: string) {
  await p.db
    .prepare(
      'UPDATE generation_jobs SET input_json=NULL,result_json=NULL WHERE id=? AND principal_key=? AND expires_at<=?',
    )
    .bind(id, key(principal), new Date().toISOString())
    .run()
  const row = await p.db
    .prepare('SELECT * FROM generation_jobs WHERE id=? AND principal_key=?')
    .bind(id, key(principal))
    .first<JobRow>()
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Generation not found')
  return row
}
export async function readGeneration(
  p: Platform,
  principal: Principal,
  id: string,
): Promise<GenerationStatus> {
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  return dto(await ownedJob(p, principal, id))
}
export async function reserveGeneration(
  p: Platform,
  principal: Principal,
  value: GenerationInput,
): Promise<{ job: GenerationStatus; admitted: boolean }> {
  const input = normalizeInput(value),
    fingerprint = await digest(JSON.stringify(input))
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  const existing = await p.db
    .prepare(
      'SELECT * FROM generation_jobs WHERE principal_key=? AND request_id=?',
    )
    .bind(key(principal), input.requestId)
    .first<JobRow>()
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'REQUEST_CONFLICT',
        'Request identity does not match',
      )
    return {
      job: await readGeneration(p, principal, existing.id),
      admitted: false,
    }
  }
  const ceiling = generationBudget(p)
  if (principal.kind === 'account')
    await initializeAccountSettings(p, principal.user)
  const now = new Date(),
    timestamp = now.toISOString(),
    day = timestamp.slice(0, 10),
    id = crypto.randomUUID(),
    recordId = crypto.randomUUID()
  const owner = principal.kind === 'account' ? principal.user.userId : null
  const guestId = principal.kind === 'guest' ? principal.guestId : null
  const sessionId = principal.kind === 'account' ? principal.sessionId : null
  const generation =
    principal.kind === 'account' ? principal.credentialGeneration : null
  const eligibility =
    principal.kind === 'guest'
      ? `EXISTS(SELECT 1 FROM generation_guests WHERE id=? AND NOT EXISTS(SELECT 1 FROM generation_claims WHERE guest_id=?))`
      : `EXISTS(SELECT 1 FROM user u JOIN session s ON s.user_id=u.id JOIN account_settings a ON a.owner_id=u.id WHERE u.id=? AND s.id=? AND u.email_verified=1 AND u.credential_generation=? AND s.credential_generation=u.credential_generation AND s.expires_at>? AND a.ai_enabled=1 AND a.consent_at IS NOT NULL)`
  const bindings =
    principal.kind === 'guest'
      ? [guestId, guestId]
      : [owner, sessionId, generation, now.getTime()]
  await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO generation_jobs(id,principal_key,guest_id,owner_id,request_id,fingerprint,session_id,credential_generation,settings_epoch,status,phase,input_json,record_id,lease_until,expires_at,created_at)
 SELECT ?,?,?,?,?,?,?,?,(SELECT settings_epoch FROM account_settings WHERE owner_id=?),'reserved','preparing',?,?,?,?,?
 WHERE ${eligibility}
 AND NOT EXISTS(SELECT 1 FROM generation_jobs WHERE principal_key=? AND status IN ('reserved','running'))
 AND (SELECT count(*) FROM generation_debits WHERE principal_key=? AND state IN ('reserved','used') AND (?='guest' OR utc_day=?))<?
 AND (SELECT count(*) FROM ai_turns WHERE owner_id=? AND status IN ('reserved','running') AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))+(SELECT count(*) FROM generation_jobs WHERE owner_id=? AND status IN ('reserved','running'))<3
 AND COALESCE((SELECT sum(reserved_micros) FROM ai_usage WHERE utc_day=?),0)+?<=? ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        key(principal),
        guestId,
        owner,
        input.requestId,
        fingerprint,
        sessionId,
        generation,
        owner,
        JSON.stringify(input),
        recordId,
        new Date(now.getTime() + generationLeaseMs).toISOString(),
        new Date(now.getTime() + 86400000).toISOString(),
        timestamp,
        ...bindings,
        key(principal),
        key(principal),
        principal.kind,
        day,
        principal.kind === 'guest' ? 2 : 10,
        owner,
        owner,
        day,
        generationReservationMicros,
        ceiling,
      ),
    p.db
      .prepare(
        "INSERT INTO generation_debits(job_id,principal_key,owner_id,utc_day,state) SELECT id,principal_key,owner_id,?,'reserved' FROM generation_jobs WHERE id=?",
      )
      .bind(day, id),
    p.db
      .prepare(
        'INSERT INTO ai_usage(turn_id,owner_id,utc_day,reserved_micros) SELECT id,owner_id,?,? FROM generation_jobs WHERE id=?',
      )
      .bind(day, generationReservationMicros, id),
  ])
  const row = await p.db
    .prepare(
      'SELECT * FROM generation_jobs WHERE principal_key=? AND request_id=?',
    )
    .bind(key(principal), input.requestId)
    .first<JobRow>()
  if (row) {
    if (row.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'REQUEST_CONFLICT',
        'Request identity does not match',
      )
    return {
      job: await readGeneration(p, principal, row.id),
      admitted: row.id === id,
    }
  }
  await assertPrincipal(p, principal)
  if (principal.kind === 'account') {
    const settings = await p.db
      .prepare(
        'SELECT ai_enabled,consent_at FROM account_settings WHERE owner_id=?',
      )
      .bind(owner)
      .first<{ ai_enabled: number; consent_at: string | null }>()
    if (!settings?.ai_enabled || !settings.consent_at)
      throw new ApiError(
        403,
        'AI_DISABLED',
        'Enable AI and acknowledge consent first',
      )
  }
  const counts = await p.db
    .prepare(
      "SELECT (SELECT count(*) FROM generation_debits WHERE principal_key=? AND state IN ('reserved','used') AND (?='guest' OR utc_day=?)) credits,(SELECT COALESCE(sum(reserved_micros),0) FROM ai_usage WHERE utc_day=?) spend",
    )
    .bind(key(principal), principal.kind, day, day)
    .first<{ credits: number; spend: number }>()
  if (
    counts &&
    (counts.credits >= (principal.kind === 'guest' ? 2 : 10) ||
      counts.spend + generationReservationMicros > ceiling)
  )
    throw new ApiError(
      429,
      'GENERATION_LIMIT_REACHED',
      'Generation allowance reached',
    )
  throw new ApiError(409, 'AI_BUSY', 'A generation is already active')
}
export async function beginGenerationAttempt(
  p: Platform,
  principal: Principal,
  id: string,
): Promise<boolean> {
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  if (!p.env.aiEnabled) return false
  const result = await p.db
    .prepare(
      `UPDATE generation_jobs SET status='running' WHERE id=? AND principal_key=? AND status='reserved' AND ${currentJobFence}`,
    )
    .bind(id, key(principal))
    .run()
  return result.meta.changes === 1
}
export async function refineGenerationReservation(
  p: Platform,
  principal: Principal,
  id: string,
  modelRequestBytes: number,
): Promise<void> {
  const reservation = refinedReservation(modelRequestBytes)
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  if (!p.env.aiEnabled)
    throw new ApiError(
      409,
      'GENERATION_STALE',
      'Generation is no longer active',
    )
  const marker = crypto.randomUUID()
  const result = await p.db.batch([
    p.db
      .prepare(
        `UPDATE generation_jobs SET refined=1,phase='writing',error_code=? WHERE id=? AND principal_key=? AND status='running' AND refined=0 AND ${currentJobFence}`,
      )
      .bind(marker, id, key(principal)),
    p.db
      .prepare(
        'UPDATE ai_usage SET reserved_micros=MIN(reserved_micros,?) WHERE turn_id=? AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=? AND error_code=?)',
      )
      .bind(reservation, id, id, marker),
    p.db
      .prepare(
        'UPDATE generation_jobs SET error_code=NULL WHERE id=? AND error_code=?',
      )
      .bind(id, marker),
  ])
  if (result[0].meta.changes !== 1)
    throw new ApiError(
      409,
      'GENERATION_STALE',
      'Generation is no longer active',
    )
}
export async function completeGeneration(
  p: Platform,
  principal: Principal,
  id: string,
  record: ThreadRecord,
): Promise<GenerationStatus> {
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  const row = await ownedJob(p, principal, id)
  if (
    !validRecord(record) ||
    !record.title.trim() ||
    record.title.length > 100 ||
    record.posts.some((x) => !x.trim() || Array.from(x).length > 1200)
  )
    throw new ApiError(422, 'INVALID_GENERATION', 'Generated thread is invalid')
  if (!p.env.aiEnabled)
    throw new ApiError(
      409,
      'GENERATION_STALE',
      'Generation is no longer active',
    )
  const result = await p.db.batch([
    p.db
      .prepare(
        `UPDATE generation_jobs SET status='complete',phase=NULL,result_json=?,error_code=NULL WHERE id=? AND principal_key=? AND status='running' AND ${currentJobFence}`,
      )
      .bind(
        JSON.stringify({ ...record, id: row.record_id }),
        id,
        key(principal),
      ),
    p.db
      .prepare(
        "UPDATE generation_debits SET state='used' WHERE job_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=? AND status='complete')",
      )
      .bind(id, id),
  ])
  if (result[0].meta.changes !== 1)
    throw new ApiError(
      409,
      'GENERATION_STALE',
      'Generation is no longer active',
    )
  return readGeneration(p, principal, id)
}
async function terminal(
  p: Platform,
  principal: Principal,
  id: string,
  status: 'failed' | 'cancelled',
  code: string,
): Promise<GenerationStatus> {
  await retireGenerationJobs(p, principal)
  await assertPrincipal(p, principal)
  await ownedJob(p, principal, id)
  await p.db.batch([
    p.db
      .prepare(
        `UPDATE generation_jobs SET status=?,phase=NULL,error_code=?,input_json=NULL,result_json=NULL WHERE id=? AND principal_key=? AND status IN ('reserved','running') AND ${currentJobFence}`,
      )
      .bind(status, code, id, key(principal)),
    p.db
      .prepare(
        "UPDATE generation_debits SET state='released' WHERE job_id=? AND state='reserved' AND EXISTS(SELECT 1 FROM generation_jobs WHERE id=? AND status IN ('failed','cancelled','stale'))",
      )
      .bind(id, id),
  ])
  return readGeneration(p, principal, id)
}
export const cancelGeneration = (
  p: Platform,
  principal: Principal,
  id: string,
) => terminal(p, principal, id, 'cancelled', 'CANCELLED')
export const failGeneration = (
  p: Platform,
  principal: Principal,
  id: string,
  code: string,
) =>
  terminal(
    p,
    principal,
    id,
    'failed',
    /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'GENERATION_FAILED',
  )
