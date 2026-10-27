import { env, waitUntil } from 'cloudflare:workers'
import { createServerOnlyFn } from '@tanstack/react-start'

export type ServerConfig = {
  authUrl: string
  authSecret: string
  emailTransport: 'capture' | 'resend'
  resendFrom: string
  resendApiKey: string
  deepseekApiKey: string
  aiEnabled: boolean
  aiDailySpendLimitUsd: number
}

export type Platform = {
  db: D1Database
  env: ServerConfig
  waitUntil: (work: Promise<unknown>) => void
}

type SecretBindings = {
  BETTER_AUTH_SECRET?: string
  RESEND_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

// Called only from server routes/functions; bindings never enter client state.
export const getPlatform = createServerOnlyFn((): Platform => {
  const bindings = env as Env & SecretBindings
  const ceiling = Number(bindings.AI_DAILY_SPEND_LIMIT_USD)
  return {
    db: bindings.DB,
    env: {
      authUrl: bindings.BETTER_AUTH_URL,
      authSecret: bindings.BETTER_AUTH_SECRET ?? '',
      emailTransport:
        bindings.EMAIL_TRANSPORT === 'resend' ? 'resend' : 'capture',
      resendFrom: bindings.RESEND_FROM,
      resendApiKey: bindings.RESEND_API_KEY ?? '',
      deepseekApiKey: bindings.DEEPSEEK_API_KEY ?? '',
      aiEnabled: bindings.AI_ENABLED === 'true',
      aiDailySpendLimitUsd:
        Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 0,
    },
    waitUntil,
  }
})
