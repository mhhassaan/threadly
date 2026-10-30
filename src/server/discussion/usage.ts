import type { AiUsageStatus, UserContext } from '../../lib/account-thread'
import type { Platform } from '../platform'
import { getSettings } from '../data/settings'
import { budget } from './budget'

/** Advisory read only. Admission remains the atomic authority; global costs stay private. */
export async function getUsageStatus(
  p: Platform,
  u: UserContext,
): Promise<AiUsageStatus> {
  const settings = await getSettings(p, u)
  const counts = await p.db
    .prepare(
      `SELECT date('now') AS day,
    (SELECT count(*) FROM ai_allowances WHERE owner_id=? AND utc_day=date('now') AND kind='opening') AS openings,
    (SELECT count(*) FROM ai_allowances WHERE owner_id=? AND utc_day=date('now') AND kind='reply') AS replies,
    (SELECT count(*) FROM ai_turns WHERE owner_id=? AND status IN ('reserved','running')) AS active,
    (SELECT COALESCE(sum(reserved_micros),0) FROM ai_usage WHERE utc_day=date('now')) AS spend`,
    )
    .bind(u.userId, u.userId, u.userId)
    .first<{
      day: string
      openings: number
      replies: number
      active: number
      spend: number
    }>()
  if (!counts) throw Error('Usage unavailable')
  let availability: AiUsageStatus['availability'] = 'unavailable'
  try {
    const { worst, ceiling } = budget(p)
    if (counts.spend + worst <= ceiling)
      availability =
        !settings.aiEnabled || !settings.consentAt
          ? 'paused'
          : counts.active >= 3
            ? 'busy'
            : 'available'
  } catch {
    /* Configuration details and operator costs are never returned. */
  }
  return {
    utcDay: counts.day,
    opening: { limit: 5, remaining: Math.max(0, 5 - counts.openings) },
    reply: { limit: 30, remaining: Math.max(0, 30 - counts.replies) },
    availability,
  }
}
