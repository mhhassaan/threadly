import { env, withEnv } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { getPlatform } from '../../src/server/platform'
import { fetchApp, privateUrlInput, readTestRow } from './helpers'

// Catches a missing/nonlocal DB binding or an adapter that breaks guest SSR/API routes.
test('platform_database_and_guest_routes', async () => {
  const platform = getPlatform()
  expect(platform.db).toBeDefined()
  expect(await readTestRow(platform.db)).toBe('local')
  expect((await fetchApp('/')).status).toBe(200)
  expect((await fetchApp('/api/article', privateUrlInput)).status).toBe(400)
})

test('local config leaves AI and outbound email disabled', () => {
  const config = getPlatform().env
  expect(config.authUrl).toBe('http://127.0.0.1:4173')
  expect(config.emailTransport).toBe('capture')
  expect(config.aiEnabled).toBe(false)
  expect(config.aiDailySpendLimitUsd).toBe(0)
  expect(Boolean(config.deepseekApiKey)).toBe(false)
  expect(Boolean(config.resendApiKey)).toBe(false)
})

// Catches a typo enabling AI, an invalid ceiling removing the limit, or unsafe transport fallback.
test.each(['-1', 'NaN', 'Infinity', ''])(
  'invalid spend ceiling %s fails closed',
  (ceiling) => {
    withEnv(
      {
        ...env,
        AI_DAILY_SPEND_LIMIT_USD: ceiling,
        AI_ENABLED: 'yes',
        EMAIL_TRANSPORT: 'typo',
      },
      () => {
        const config = getPlatform().env
        expect(config.aiDailySpendLimitUsd).toBe(0)
        expect(config.aiEnabled).toBe(false)
        expect(config.emailTransport).toBe('capture')
      },
    )
  },
)

test('explicit operator switch and positive spend ceiling are exposed to server consumers', () => {
  withEnv(
    {
      ...env,
      AI_ENABLED: 'true',
      AI_DAILY_SPEND_LIMIT_USD: '1.25',
      EMAIL_TRANSPORT: 'resend',
    },
    () => {
      const config = getPlatform().env
      expect(config.aiEnabled).toBe(true)
      expect(config.aiDailySpendLimitUsd).toBe(1.25)
      expect(config.emailTransport).toBe('resend')
    },
  )
})
