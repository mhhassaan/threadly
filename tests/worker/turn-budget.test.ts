import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
import {
  reserveTurn,
  cancelTurn,
  settleTurn,
} from '../../src/server/discussion/turns'
import { getSettings, updateSettings } from '../../src/server/data/settings'
import type { Platform } from '../../src/server/platform'

const user = {
  userId: 'alice',
  email: 'alice@example.invalid',
  name: 'Alice',
  verified: true,
}
const platform: Platform = {
  db: env.DB,
  env: {
    authUrl: 'http://localhost',
    authSecret: '',
    emailTransport: 'capture',
    dev: true,
    devMailUrl: '',
    resendFrom: '',
    resendApiKey: '',
    deepseekApiKey: 'test',
    aiEnabled: true,
    aiDailySpendLimitUsd: 100,
    aiWorstCaseCostMicros: 1000,
  },
  waitUntil() {},
}
const threadIds = Array.from({ length: 35 }, () => crypto.randomUUID())
const request = (threadId: string, kind: 'reply' | 'opening' = 'reply') => ({
  requestId: crypto.randomUUID(),
  threadId,
  kind,
  triggerCommentId: null,
})
const reserve = (threadId: string, kind: 'reply' | 'opening' = 'reply') =>
  reserveTurn(platform, user, request(threadId, kind))
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  await applyMigration(env.DB, reading)
  await applyMigration(env.DB, turns)
})
beforeEach(async () => {
  vi.useRealTimers()
  await env.DB.prepare('DELETE FROM ai_usage').run()
  await env.DB.prepare('DELETE FROM "user"').run()
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(user.userId, user.name, user.email)
    .run()
  for (const id of threadIds)
    await env.DB.prepare(
      "INSERT INTO owned_threads (id, owner_id, record_json, mutation_id, created_at, updated_at) VALUES (?, 'alice', '{}', 'm', 'now', 'now')",
    )
      .bind(id)
      .run()
  await updateSettings(platform, user, {
    aiEnabled: true,
    acknowledgeConsent: true,
  })
})

test('thirty_turn_daily_cap', async () => {
  for (let i = 0; i < 30; i++) {
    const t = await reserve(threadIds[i])
    await settleTurn(
      platform,
      user,
      t.id,
      { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
      'complete',
    )
  }
  await expect(reserve(threadIds[30])).rejects.toMatchObject({ status: 429 })
})
test('five_openings_cap', async () => {
  for (let i = 0; i < 5; i++) {
    const t = await reserve(threadIds[i], 'opening')
    await cancelTurn(platform, user, t.id)
  }
  await expect(reserve(threadIds[5], 'opening')).rejects.toMatchObject({
    status: 429,
  })
})
test('three_account_one_thread_active', async () => {
  const results = await Promise.allSettled(
    threadIds.slice(0, 10).map((id) => reserve(id)),
  )
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(3)
  const winner = results.find((x) => x.status === 'fulfilled')
  expect(winner?.status).toBe('fulfilled')
  await expect(reserve(threadIds[0])).rejects.toMatchObject({ status: 409 })
})
test('duplicate_request_single_reservation', async () => {
  const input = request(threadIds[0], 'opening')
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveTurn(platform, user, input)),
  )
  expect(new Set(results.map((x) => x.id)).size).toBe(1)
  expect((await reserve(threadIds[0], 'opening')).id).toBe(results[0].id)
})
test('utc_rollover', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T23:59:59Z'))
  for (let i = 0; i < 5; i++) {
    const t = await reserve(threadIds[i], 'opening')
    await cancelTurn(platform, user, t.id)
  }
  vi.setSystemTime(new Date('2026-10-28T00:00:01Z'))
  expect((await reserve(threadIds[5], 'opening')).status).toBe('reserved')
})
test('crash_lease_expires', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
  const old = await reserve(threadIds[0])
  vi.advanceTimersByTime(91_000)
  expect((await reserve(threadIds[0])).status).toBe('reserved')
  await expect(
    settleTurn(
      platform,
      user,
      old.id,
      { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
      'complete',
    ),
  ).rejects.toMatchObject({ status: 409 })
})
test('settings_default_off_and_consent_server_timestamp', async () => {
  await env.DB.prepare('DELETE FROM account_settings WHERE owner_id = ?')
    .bind(user.userId)
    .run()
  expect(await getSettings(platform, user)).toEqual({
    aiEnabled: false,
    memoryEnabled: false,
    consentAt: null,
    memoryEpoch: 0,
  })
  await expect(reserve(threadIds[0])).rejects.toMatchObject({ status: 403 })
  expect(
    (await updateSettings(platform, user, { acknowledgeConsent: true }))
      .consentAt,
  ).toBeTruthy()
})

test('retry_has_new_attempt_and_old_completion_is_fenced', async () => {
  const input = request(threadIds[0])
  const old = await reserveTurn(platform, user, input)
  await settleTurn(
    platform,
    user,
    old.id,
    { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
    'failed',
  )
  const next = await reserveTurn(platform, user, input)
  expect(next.id).not.toBe(old.id)
  await expect(
    settleTurn(
      platform,
      user,
      old.id,
      { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
      'complete',
    ),
  ).rejects.toMatchObject({ status: 409 })
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(2)
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM ai_requests').first<{
        n: number
      }>()
    )?.n,
  ).toBe(1)
})
test('budget_survives_thread_deletion', async () => {
  const old = platform.env.aiDailySpendLimitUsd
  platform.env.aiDailySpendLimitUsd = 0.001
  try {
    await reserve(threadIds[0])
    await env.DB.prepare('DELETE FROM owned_threads WHERE id = ?')
      .bind(threadIds[0])
      .run()
    await expect(reserve(threadIds[1])).rejects.toMatchObject({ status: 429 })
  } finally {
    platform.env.aiDailySpendLimitUsd = old
  }
})
test('missing_configuration_fails_closed', async () => {
  const old = platform.env.aiWorstCaseCostMicros
  platform.env.aiWorstCaseCostMicros = undefined
  try {
    await expect(reserve(threadIds[0])).rejects.toMatchObject({
      status: 503,
      code: 'AI_CONFIGURATION_REQUIRED',
    })
  } finally {
    platform.env.aiWorstCaseCostMicros = old
  }
})
test('ai_off_cancels_and_fences_generation', async () => {
  const turn = await reserve(threadIds[0])
  await updateSettings(platform, user, { aiEnabled: false })
  await expect(
    settleTurn(
      platform,
      user,
      turn.id,
      { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
      'complete',
    ),
  ).rejects.toMatchObject({ status: 409 })
})

test('budget_survives_account_deletion_without_identity', async () => {
  const turn = await reserve(threadIds[0])
  await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
    .bind(user.userId)
    .run()
  expect(
    await env.DB.prepare(
      'SELECT owner_id, reserved_micros FROM ai_usage WHERE turn_id = ?',
    )
      .bind(turn.id)
      .first(),
  ).toEqual({ owner_id: null, reserved_micros: 1000 })
})

test('failed_retry_requires_new_spend_reservation', async () => {
  const input = request(threadIds[0])
  const first = await reserveTurn(platform, user, input)
  await settleTurn(
    platform,
    user,
    first.id,
    { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
    'failed',
  )
  const old = platform.env.aiDailySpendLimitUsd
  platform.env.aiDailySpendLimitUsd = 0.001
  try {
    await expect(reserveTurn(platform, user, input)).rejects.toMatchObject({
      status: 429,
    })
  } finally {
    platform.env.aiDailySpendLimitUsd = old
  }
})

test('global_ai_off_fences_finalization', async () => {
  const turn = await reserve(threadIds[0])
  platform.env.aiEnabled = false
  try {
    await expect(
      settleTurn(
        platform,
        user,
        turn.id,
        { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
        'complete',
      ),
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    platform.env.aiEnabled = true
  }
})

test('opening_duplicate_new_device_does_not_retry_failed_request', async () => {
  const first = await reserve(threadIds[0], 'opening')
  await settleTurn(
    platform,
    user,
    first.id,
    { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
    'failed',
  )
  const duplicate = await reserve(threadIds[0], 'opening')
  expect(duplicate.id).toBe(first.id)
  expect(duplicate.status).toBe('failed')
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(1)
})

test('opening_duplicate_ignores_different_trigger', async () => {
  const first = await reserveTurn(platform, user, {
    ...request(threadIds[0], 'opening'),
    triggerCommentId: crypto.randomUUID(),
  })
  const duplicate = await reserveTurn(platform, user, {
    ...request(threadIds[0], 'opening'),
    triggerCommentId: crypto.randomUUID(),
  })
  expect(duplicate.id).toBe(first.id)
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM ai_usage').first<{
        n: number
      }>()
    )?.n,
  ).toBe(1)
})

test('settings_noop_patches_preserve_active_turn', async () => {
  const turn = await reserve(threadIds[0])
  const before = await env.DB.prepare(
    'SELECT settings_epoch FROM account_settings WHERE owner_id = ?',
  )
    .bind(user.userId)
    .first<{ settings_epoch: number }>()
  await updateSettings(platform, user, {})
  await updateSettings(platform, user, {
    aiEnabled: true,
    memoryEnabled: false,
    acknowledgeConsent: true,
  })
  expect(
    await env.DB.prepare(
      'SELECT settings_epoch FROM account_settings WHERE owner_id = ?',
    )
      .bind(user.userId)
      .first(),
  ).toEqual(before)
  await settleTurn(
    platform,
    user,
    turn.id,
    { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
    'complete',
  )
})

test('settings_memory_change_cancels_active_turn_and_releases_slots', async () => {
  const turns = await Promise.all(
    threadIds.slice(0, 3).map((id) => reserve(id)),
  )
  await updateSettings(platform, user, { memoryEnabled: true })
  for (const turn of turns) {
    expect(
      await env.DB.prepare('SELECT status FROM ai_turns WHERE id = ?')
        .bind(turn.id)
        .first(),
    ).toEqual({ status: 'cancelled' })
    await expect(
      settleTurn(
        platform,
        user,
        turn.id,
        { inputTokens: 1, outputTokens: 1, estimatedCostMicros: 1 },
        'complete',
      ),
    ).rejects.toMatchObject({ status: 409 })
  }
  expect((await reserve(threadIds[0])).status).toBe('reserved')
  expect((await reserve(threadIds[3])).status).toBe('reserved')
})

test('concurrent_identical_settings_changes_increment_epoch_once', async () => {
  const turn = await reserve(threadIds[0])
  const before = await env.DB.prepare(
    'SELECT settings_epoch FROM account_settings WHERE owner_id = ?',
  )
    .bind(user.userId)
    .first<{ settings_epoch: number }>()
  await Promise.all(
    Array.from({ length: 8 }, () =>
      updateSettings(platform, user, { memoryEnabled: true }),
    ),
  )
  const after = await env.DB.prepare(
    'SELECT settings_epoch FROM account_settings WHERE owner_id = ?',
  )
    .bind(user.userId)
    .first<{ settings_epoch: number }>()
  expect(after!.settings_epoch).toBe(before!.settings_epoch + 1)
  expect(
    await env.DB.prepare('SELECT status FROM ai_turns WHERE id = ?')
      .bind(turn.id)
      .first(),
  ).toEqual({ status: 'cancelled' })
  expect((await reserve(threadIds[0])).status).toBe('reserved')
})
