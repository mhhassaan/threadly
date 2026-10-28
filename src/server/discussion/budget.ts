import { ApiError } from '../../lib/account-thread'
import type { Platform } from '../platform'

export function budget(p: Platform): { worst: number; ceiling: number } {
  const worst = p.env.aiWorstCaseCostMicros
  const ceiling = Math.floor(p.env.aiDailySpendLimitUsd * 1_000_000)
  if (
    !p.env.aiEnabled ||
    !p.env.deepseekApiKey ||
    !Number.isSafeInteger(worst) ||
    !worst ||
    worst < 1 ||
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
