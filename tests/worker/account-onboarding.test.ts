import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createAuth } from '../../src/server/auth/auth'
import { requireUser } from '../../src/server/auth/session'
import type { Platform } from '../../src/server/platform'
import { applyAuthMigrations, applyMigration } from './migrations'
import { fetchApp } from './helpers'

import { getSettings, updateSettings } from '../../src/server/data/settings'
import { clearMemory } from '../../src/server/data/privacy'
import { reserveTurn } from '../../src/server/discussion/turns'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
import ui from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
import admissions from '../../drizzle/migrations/0008_opening_admissions.sql?raw'
import memory from '../../drizzle/migrations/0009_memory.sql?raw'
import privacy from '../../drizzle/migrations/0010_privacy.sql?raw'
const version = '2026-10-30-v1'
const base = 'http://127.0.0.1:4176'
let messages: { text: string }[] = []
let background: Promise<unknown>[] = []
let platform: Platform
let auth: ReturnType<typeof createAuth>
const credentials = () => ({
  email: `person-${crypto.randomUUID()}@example.invalid`,
  password: crypto.randomUUID() + crypto.randomUUID(),
  name: 'Test reader',
})
function jar(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}
async function post(path: string, body: unknown, cookie = '', origin = base) {
  return auth.handler(
    new Request(`${base}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(body),
    }),
  )
}
async function link() {
  await Promise.all(background)
  const text = messages.at(-1)?.text ?? ''
  const value = text.match(/http[^\s]+/)?.[0]
  if (!value) throw new Error('No captured link')
  return value
}
async function verifiedLogin(
  person: ReturnType<typeof credentials> & {
    aiProcessingNoticeVersion?: string
  } = credentials(),
) {
  expect((await post('sign-up/email', person)).ok).toBe(true)
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const response = await post('sign-in/email', person)
  expect(response.ok).toBe(true)
  return { person, cookie: jar(response) }
}
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  for (const source of [reading, turns, ui, admissions, memory, privacy])
    await applyMigration(env.DB, source)
})
beforeEach(async () => {
  for (const table of [
    'session',
    'account',
    'verification',
    'user',
    'rate_limit',
  ])
    await env.DB.prepare(`DELETE FROM "${table}"`).run()
  messages = []
  background = []
  platform = {
    db: env.DB,
    env: {
      authUrl: base,
      authSecret: crypto.randomUUID() + crypto.randomUUID(),
      emailTransport: 'capture',
      dev: true,
      devMailUrl: 'http://127.0.0.1:4187',
      resendFrom: '',
      resendApiKey: '',
      deepseekApiKey: '',
      aiEnabled: false,
      aiDailySpendLimitUsd: 0,
    },
    waitUntil(work) {
      background.push(work)
    },
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    messages.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 'captured' })
  })
  auth = createAuth(platform)
})
afterEach(() => vi.restoreAllMocks())

async function ownerFor(cookie: string) {
  return requireUser(new Request(base, { headers: { cookie } }), platform)
}
async function admission(cookie: string) {
  const owner = await ownerFor(cookie)
  const threadId = crypto.randomUUID()
  await env.DB.prepare(
    "INSERT INTO owned_threads (id, owner_id, record_json, mutation_id, created_at, updated_at) VALUES (?, ?, '{}', 'm', 'now', 'now')",
  )
    .bind(threadId, owner.userId)
    .run()
  platform.env = {
    ...platform.env,
    aiEnabled: true,
    deepseekApiKey: 'fake',
    aiDailySpendLimitUsd: 100,
    aiWorstCaseCostMicros: 1000,
  }
  return reserveTurn(platform, owner, {
    requestId: crypto.randomUUID(),
    threadId,
    kind: 'reply',
    triggerCommentId: null,
  })
}
test('signup_with_current_notice_defaults_ai_on_after_verification', async () => {
  const { cookie } = await verifiedLogin({
    ...credentials(),
    aiProcessingNoticeVersion: version,
  })
  const owner = await ownerFor(cookie)
  const stored = await env.DB.prepare(
    'SELECT created_at FROM "user" WHERE id=?',
  )
    .bind(owner.userId)
    .first<{ created_at: number }>()
  expect(await getSettings(platform, owner)).toEqual({
    aiEnabled: true,
    consentAt: new Date(stored!.created_at).toISOString(),
    memoryEnabled: false,
    memoryEpoch: 0,
  })
})
test('missing_or_unknown_notice_keeps_ai_off_without_consent', async () => {
  for (const aiProcessingNoticeVersion of [undefined, 'future-unknown']) {
    const { cookie } = await verifiedLogin({
      ...credentials(),
      aiProcessingNoticeVersion,
    })
    expect(await getSettings(platform, await ownerFor(cookie))).toMatchObject({
      aiEnabled: false,
      consentAt: null,
      memoryEnabled: false,
    })
    await expect(admission(cookie)).rejects.toMatchObject({
      code: 'AI_DISABLED',
    })
  }
})
test('old_paused_settings_unchanged_on_read_login_and_admission', async () => {
  const { person, cookie } = await verifiedLogin({
    ...credentials(),
    aiProcessingNoticeVersion: version,
  })
  const owner = await ownerFor(cookie)
  await updateSettings(platform, owner, {
    aiEnabled: false,
    acknowledgeConsent: true,
  })
  const before = await env.DB.prepare(
    'SELECT * FROM account_settings WHERE owner_id=?',
  )
    .bind(owner.userId)
    .first()
  await getSettings(platform, owner)
  await post('sign-in/email', person)
  await expect(admission(cookie)).rejects.toMatchObject({ code: 'AI_DISABLED' })
  expect(
    await env.DB.prepare('SELECT * FROM account_settings WHERE owner_id=?')
      .bind(owner.userId)
      .first(),
  ).toEqual(before)
})
test('new_default_settings_match_atomic_admission', async () => {
  const { cookie } = await verifiedLogin({
    ...credentials(),
    aiProcessingNoticeVersion: version,
  })
  expect((await admission(cookie)).status).toBe('reserved')
  expect(await getSettings(platform, await ownerFor(cookie))).toMatchObject({
    aiEnabled: true,
    consentAt: expect.any(String),
    memoryEnabled: false,
  })
})
test('signup_notice_not_returned_as_profile_data', async () => {
  const person = { ...credentials(), aiProcessingNoticeVersion: version }
  const signup = await post('sign-up/email', person)
  expect(signup.ok).toBe(true)
  expect(JSON.stringify(await signup.json())).not.toContain(
    'aiProcessingNoticeVersion',
  )
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const signin = await post('sign-in/email', person)
  const response = await auth.handler(
    new Request(`${base}/api/auth/get-session`, {
      headers: { cookie: jar(signin) },
    }),
  )
  expect(JSON.stringify(await response.json())).not.toContain(
    'aiProcessingNoticeVersion',
  )
  expect(
    await env.DB.prepare(
      'SELECT ai_processing_notice_version FROM "user" WHERE email=?',
    )
      .bind(person.email)
      .first(),
  ).toEqual({ ai_processing_notice_version: version })
})

test('profile_update_cannot_invent_signup_receipt', async () => {
  const { cookie } = await verifiedLogin()
  expect(
    (await post('update-user', { aiProcessingNoticeVersion: version }, cookie))
      .ok,
  ).toBe(false)
  expect(
    await env.DB.prepare(
      'SELECT ai_processing_notice_version FROM "user" WHERE id=?',
    )
      .bind((await ownerFor(cookie)).userId)
      .first(),
  ).toEqual({ ai_processing_notice_version: null })
})

test('privacy_first_initialization_uses_signup_defaults_and_preserves_memory_reset', async () => {
  const { cookie } = await verifiedLogin({
    ...credentials(),
    aiProcessingNoticeVersion: version,
  })
  const owner = await ownerFor(cookie)
  await clearMemory(platform, owner)
  expect(await getSettings(platform, owner)).toMatchObject({
    aiEnabled: true,
    consentAt: expect.any(String),
    memoryEnabled: false,
    memoryEpoch: 1,
  })
  await getSettings(platform, owner)
  expect((await getSettings(platform, owner)).memoryEpoch).toBe(1)
})
