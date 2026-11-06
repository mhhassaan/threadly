import { ApiError, type UserContext } from '../../lib/account-thread'
import type { GenerationInput } from '../../lib/thread-generation'
import { processingNoticeVersion } from '../../lib/ai-processing'
import type { Platform } from '../platform'
export type Principal =
  | { kind: 'guest'; guestId: string }
  | {
      kind: 'account'
      user: UserContext
      sessionId: string
      credentialGeneration: number
    }
export const generationReservationMicros = 300000
export const maxModelRequestBytes = 422048
export const generationLeaseMs = 180000
export const key = (p: Principal) =>
  p.kind === 'guest' ? 'guest:' + p.guestId : 'account:' + p.user.userId
export async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}
export function normalizeInput(value: GenerationInput): GenerationInput {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.requestId,
    ) ||
    !['text', 'file', 'url'].includes(value.mode) ||
    !['quick', 'balanced', 'detailed'].includes(value.depth) ||
    !(
      value.length === 'auto' ||
      (Number.isInteger(value.length) &&
        value.length >= 1 &&
        value.length <= 100)
    ) ||
    typeof value.source !== 'string' ||
    !value.source.trim() ||
    value.source.length > 100000 ||
    value.noticeVersion !== processingNoticeVersion
  )
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Check the source, options and AI notice',
    )
  return {
    requestId: value.requestId,
    mode: value.mode,
    source: value.source.replace(/\r\n?/g, '\n').trim(),
    depth: value.depth,
    length: value.length,
    noticeVersion: value.noticeVersion,
  }
}
export function generationBudget(p: Platform) {
  const ceiling = Math.floor(p.env.aiDailySpendLimitUsd * 1000000)
  if (
    !p.env.aiEnabled ||
    !p.env.deepseekApiKey ||
    !Number.isSafeInteger(ceiling) ||
    ceiling < generationReservationMicros
  )
    throw new ApiError(
      503,
      'AI_CONFIGURATION_REQUIRED',
      'AI generation is temporarily unavailable',
    )
  return ceiling
}
// Byte fallback is a conservative token bound; keep two attempts, full output and one Fetch.
export function refinedReservation(bytes: number) {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes + 2048 > maxModelRequestBytes
  )
    throw new ApiError(
      422,
      'CONTEXT_TOO_LARGE',
      'Source exceeds the generation input limit',
    )
  return Math.ceil(2 * ((bytes + 2048) * 0.3 + 16384 * 1.2) + 750)
}
export const currentJobFence = `lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (
 (guest_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generation_claims c WHERE c.guest_id=generation_jobs.guest_id)) OR
 (owner_id IS NOT NULL AND EXISTS(SELECT 1 FROM user u JOIN session s ON s.user_id=u.id JOIN account_settings a ON a.owner_id=u.id WHERE u.id=generation_jobs.owner_id AND u.email_verified=1 AND u.credential_generation=generation_jobs.credential_generation AND s.id=generation_jobs.session_id AND s.credential_generation=u.credential_generation AND s.expires_at>unixepoch('now')*1000 AND a.ai_enabled=1 AND a.consent_at IS NOT NULL AND a.settings_epoch=generation_jobs.settings_epoch))
)`
export async function assertPrincipal(p: Platform, principal: Principal) {
  if (principal.kind === 'guest') {
    if (
      !(await p.db
        .prepare(
          'SELECT 1 FROM generation_guests g WHERE id=? AND NOT EXISTS(SELECT 1 FROM generation_claims c WHERE c.guest_id=g.id)',
        )
        .bind(principal.guestId)
        .first())
    )
      throw new ApiError(409, 'GUEST_CLAIMED', 'Sign in to continue')
  } else {
    if (!principal.user.verified)
      throw new ApiError(
        403,
        'EMAIL_VERIFICATION_REQUIRED',
        'Verify your email to continue',
      )
    if (
      !(await p.db
        .prepare(
          'SELECT 1 FROM user u JOIN session s ON s.user_id=u.id WHERE u.id=? AND u.email_verified=1 AND u.credential_generation=? AND s.id=? AND s.credential_generation=u.credential_generation AND s.expires_at>?',
        )
        .bind(
          principal.user.userId,
          principal.credentialGeneration,
          principal.sessionId,
          Date.now(),
        )
        .first())
    )
      throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue')
  }
}
