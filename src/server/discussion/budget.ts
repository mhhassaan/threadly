import { ApiError } from '../../lib/account-thread'
import type { Platform } from '../platform'

export function budget(p: Platform): { worst: number; ceiling: number } {
  const configured = p.env.aiWorstCaseCostMicros
  // Two attempts: <=12000 serialized-input bytes and <=1200 output tokens each.
  const worst = Math.max(configured ?? 0, 10080)
  const ceiling = Math.floor(p.env.aiDailySpendLimitUsd * 1_000_000)
  if (
    !p.env.aiEnabled ||
    !p.env.deepseekApiKey ||
    !Number.isSafeInteger(configured) ||
    !configured ||
    configured < 1 ||
    !Number.isSafeInteger(ceiling) ||
    ceiling < worst
  )
    throw new ApiError(
      503,
      'AI_CONFIGURATION_REQUIRED',
      'Configure the AI key, worst-case request cost and daily spend ceiling',
    )
  return { worst, ceiling }
}
