import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import turns from '../../drizzle/migrations/0006_turns.sql?raw'
import ui from '../../drizzle/migrations/0007_discussion_ui.sql?raw'
import opening from '../../drizzle/migrations/0008_opening_admissions.sql?raw'
import memory from '../../drizzle/migrations/0009_memory.sql?raw'
import privacy from '../../drizzle/migrations/0010_privacy.sql?raw'
import {
  resolveGenerationPrincipal,
  guestCookieName,
} from '../../src/server/thread-generation/identity'
import {
  getGenerationQuota,
  claimGuestUsage,
} from '../../src/server/thread-generation/quota'
import {
  reserveGeneration,
  beginGenerationAttempt,
  completeGeneration,
  failGeneration,
  cancelGeneration,
  readGeneration,
  refineGenerationReservation,
} from '../../src/server/thread-generation/jobs'
import {
  type Principal,
  digest,
  refinedReservation,
} from '../../src/server/thread-generation/policy'
import { reserveTurn } from '../../src/server/discussion/turns'
import { budget } from '../../src/server/discussion/budget'
import { updateSettings } from '../../src/server/data/settings'
import type { Platform } from '../../src/server/platform'
import type { GenerationInput } from '../../src/lib/thread-generation'
import type { ThreadRecord } from '../../src/lib/thread'
const base = 'http://localhost:4176'
const p: Platform = {
  db: env.DB,
  env: {
    authUrl: base,
    authSecret: 'test-generation-secret-only-01234567890123456789',
    emailTransport: 'capture',
    dev: true,
    devMailUrl: '',
    resendFrom: '',
    resendApiKey: '',
    deepseekApiKey: 'fake-test-key',
    aiEnabled: true,
    aiDailySpendLimitUsd: 100,
    aiWorstCaseCostMicros: 1000,
  },
  waitUntil() {},
}
const user = {
  userId: 'alice',
  email: 'alice@example.invalid',
  name: 'Alice',
  verified: true,
}
const account: Principal = {
  kind: 'account',
  user,
  sessionId: 'alice-session',
  credentialGeneration: 0,
}
const input = (source = 'Public synthetic source'): GenerationInput => ({
  requestId: crypto.randomUUID(),
  mode: 'text',
  source,
  depth: 'balanced',
  length: 'auto',
  noticeVersion: '2026-10-30-v1',
})
const record: ThreadRecord = {
  id: 'untrusted-id',
  title: 'Synthetic',
  posts: ['One complete supported thought.'],
  sourceUrl: '',
  source: null,
  media: [],
  interactions: {},
  sourceText: 'Public synthetic source',
}
const req = (cookie = '') =>
  new Request(base + '/api/generations', { headers: { cookie } })
const row = (sql: string, ...values: (string | number | null)[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first<any>()
async function guest() {
  const resolved = await resolveGenerationPrincipal(p, req(), {
    createGuest: true,
  })
  return {
    principal: resolved.principal,
    cookie: resolved.setCookie!.split(';')[0],
    setCookie: resolved.setCookie!,
  }
}
async function done(principal: Principal, value = input()) {
  const { job } = await reserveGeneration(p, principal, value)
  expect(await beginGenerationAttempt(p, principal, job.id)).toBe(true)
  return completeGeneration(p, principal, job.id, record)
}
async function authCookie(id = 'alice') {
  const token = id + '-token'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(p.env.authSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token)),
      ),
    ),
  )
  return (
    'better-auth.session_token=' + encodeURIComponent(token + '.' + signature)
  )
}
async function claimRequest(cookie: string, id = 'alice') {
  return req(cookie + '; ' + (await authCookie(id)))
}
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  for (const s of [reading, turns, ui, opening, memory, privacy])
    await applyMigration(env.DB, s)
})
beforeEach(async () => {
  vi.useRealTimers()
  p.env.aiDailySpendLimitUsd = 100
  p.env.aiEnabled = true
  await env.DB.prepare('DELETE FROM generation_debits').run()
  await env.DB.prepare('DELETE FROM generation_jobs').run()
  await env.DB.prepare('DELETE FROM generation_claims').run()
  await env.DB.prepare('DELETE FROM generation_guests').run()
  await env.DB.prepare('DELETE FROM ai_usage').run()
  await env.DB.prepare('DELETE FROM user').run()
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,email_verified,created_at,updated_at,ai_processing_notice_version) VALUES(?,?,?,1,1,1,?)',
    )
      .bind(id, id, id + '@example.invalid', '2026-10-30-v1')
      .run()
    await env.DB.prepare(
      'INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,1,1)',
    )
      .bind(id + '-session', id, id + '-token', Date.now() + 86400000 * 10)
      .run()
  }
})
afterEach(() => vi.useRealTimers())
test('generation durable guest identity exists', async () =>
  expect(
    await row(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='generation_guests'",
    ),
  ).toEqual({ name: 'generation_guests' }))
test('opaque cookie has actual HTTP attributes and only SHA256 is stored', async () => {
  const g = await guest()
  expect(g.setCookie).toContain(
    'HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000',
  )
  const token = g.cookie.split('=')[1]
  expect(await row('SELECT token_digest FROM generation_guests')).toEqual({
    token_digest: await digest(token),
  })
  expect(
    (await resolveGenerationPrincipal(p, req(g.cookie), { createGuest: false }))
      .principal,
  ).toEqual(g.principal)
  const secure = await resolveGenerationPrincipal(
    p,
    new Request('https://localhost/api/generations'),
    { createGuest: true },
  )
  expect(secure.setCookie).toContain('; Secure')
})
test('unrecognized client cookie never supplies usage or identity', async () => {
  await expect(
    resolveGenerationPrincipal(p, req(guestCookieName + '=forged'), {
      createGuest: false,
    }),
  ).rejects.toMatchObject({ status: 401 })
  await expect(
    resolveGenerationPrincipal(p, req('better-auth.session_token=expired'), {
      createGuest: true,
    }),
  ).rejects.toMatchObject({ status: 401 })
})
test('guest_successes_stop_at2 and thirdguestdenied', async () => {
  const g = await guest()
  await done(g.principal)
  await done(g.principal)
  expect(await getGenerationQuota(p, g.principal)).toMatchObject({
    used: 2,
    reserved: 0,
    remaining: 0,
    resetAt: null,
  })
  await expect(
    reserveGeneration(p, g.principal, input()),
  ).rejects.toMatchObject({ status: 429 })
  expect(
    (await row("SELECT count(*) n FROM generation_debits WHERE state='used'"))
      .n,
  ).toBe(2)
})
test('pending_reserves_then_failure_releases_slot but retains spend and clears content', async () => {
  const g = await guest()
  const { job } = await reserveGeneration(p, g.principal, input())
  expect(await getGenerationQuota(p, g.principal)).toMatchObject({
    used: 0,
    reserved: 1,
    remaining: 1,
  })
  await failGeneration(p, g.principal, job.id, 'SOURCE_UNAVAILABLE')
  expect(await getGenerationQuota(p, g.principal)).toMatchObject({
    reserved: 0,
    remaining: 2,
  })
  expect(
    await row(
      'SELECT input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ input_json: null, result_json: null })
  expect(
    await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id),
  ).toEqual({ reserved_micros: 300000 })
})
test('duplicate_request_same_body_no_second_admission and changed_body409', async () => {
  const g = await guest()
  const value = input()
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveGeneration(p, g.principal, value)),
  )
  expect(results.filter((x) => x.admitted)).toHaveLength(1)
  expect(new Set(results.map((x) => x.job.id)).size).toBe(1)
  expect((await row('SELECT count(*) n FROM ai_usage')).n).toBe(1)
  await expect(
    reserveGeneration(p, g.principal, { ...value, source: 'Changed' }),
  ).rejects.toMatchObject({ status: 409, code: 'REQUEST_CONFLICT' })
  const begins = await Promise.all(
    results.map((x) => beginGenerationAttempt(p, g.principal, x.job.id)),
  )
  expect(begins.filter(Boolean)).toHaveLength(1)
})
test('completed_delete_no_refund and server assigns stable result id', async () => {
  const g = await guest()
  const value = input()
  const job = await done(g.principal, value)
  expect(job.record?.id).not.toBe(record.id)
  expect((await reserveGeneration(p, g.principal, value)).job.record?.id).toBe(
    job.record?.id,
  )
  await cancelGeneration(p, g.principal, job.id)
  expect(await getGenerationQuota(p, g.principal)).toMatchObject({
    used: 1,
    remaining: 1,
  })
})
test.each([1, 2])(
  'guest_claim_%i debits account once and repeated sign-in never reclaims',
  async (n) => {
    const g = await guest()
    for (let i = 0; i < n; i++) await done(g.principal)
    const request = await claimRequest(g.cookie)
    expect(await claimGuestUsage(p, user, request)).toMatchObject({
      used: n,
      remaining: 10 - n,
    })
    expect(await claimGuestUsage(p, user, request)).toMatchObject({
      used: n,
      remaining: 10 - n,
    })
    expect((await row('SELECT count(*) n FROM generation_claims')).n).toBe(1)
    await expect(
      reserveGeneration(p, g.principal, input()),
    ).rejects.toMatchObject({ status: 409 })
  },
)
test('claim_cross_midnight_uses_claimday and later day resets', async () => {
  const g = await guest()
  await done(g.principal)
  const tomorrow = new Date(Date.now() + 86400000)
  vi.useFakeTimers()
  vi.setSystemTime(tomorrow)
  expect(
    await claimGuestUsage(p, user, await claimRequest(g.cookie)),
  ).toMatchObject({ used: 1, remaining: 9 })
  expect((await row('SELECT utc_day FROM generation_debits')).utc_day).toBe(
    tomorrow.toISOString().slice(0, 10),
  )
  vi.setSystemTime(new Date(tomorrow.getTime() + 86400000))
  expect(await getGenerationQuota(p, account)).toMatchObject({
    used: 0,
    remaining: 10,
  })
})
test('otheraccount_no_reclaim and account cannot claim multiple browser identities', async () => {
  const g = await guest()
  await done(g.principal)
  await claimGuestUsage(p, user, await claimRequest(g.cookie))
  const bob = { ...user, userId: 'bob', email: 'bob@example.invalid' }
  expect(
    await claimGuestUsage(p, bob, await claimRequest(g.cookie, 'bob')),
  ).toMatchObject({ used: 0 })
  const second = await guest()
  await done(second.principal)
  expect(
    await claimGuestUsage(p, user, await claimRequest(second.cookie)),
  ).toMatchObject({ used: 1 })
  expect((await row('SELECT count(*) n FROM generation_claims')).n).toBe(1)
})
test('account_10_then429 and next_UTCday10', async () => {
  for (let i = 0; i < 10; i++) await done(account)
  await expect(reserveGeneration(p, account, input())).rejects.toMatchObject({
    status: 429,
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(Date.now() + 86400000))
  expect(await getGenerationQuota(p, account)).toMatchObject({
    used: 0,
    remaining: 10,
  })
  expect((await reserveGeneration(p, account, input())).admitted).toBe(true)
})
test('claim cancels active guest job atomically and fences late completion', async () => {
  const g = await guest()
  const { job } = await reserveGeneration(p, g.principal, input())
  await beginGenerationAttempt(p, g.principal, job.id)
  await claimGuestUsage(p, user, await claimRequest(g.cookie))
  await expect(
    completeGeneration(p, g.principal, job.id, record),
  ).rejects.toMatchObject({ status: 409 })
  expect(
    await row(
      'SELECT status,input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ status: 'cancelled', input_json: null, result_json: null })
  expect(await getGenerationQuota(p, account)).toMatchObject({
    used: 0,
    reserved: 0,
  })
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBe(300000)
})
test('completion_claim_race_one_winner', async () => {
  const g = await guest()
  const { job } = await reserveGeneration(p, g.principal, input())
  await beginGenerationAttempt(p, g.principal, job.id)
  await Promise.allSettled([
    completeGeneration(p, g.principal, job.id, record),
    claimGuestUsage(p, user, await claimRequest(g.cookie)),
  ])
  const state = await row(
    'SELECT status FROM generation_jobs WHERE id=?',
    job.id,
  )
  expect(['complete', 'cancelled']).toContain(state.status)
  expect(await getGenerationQuota(p, account)).toMatchObject({
    used: state.status === 'complete' ? 1 : 0,
    reserved: 0,
  })
  expect((await row('SELECT count(*) n FROM generation_debits')).n).toBe(1)
})
test('accountdelete_keeps_money_notprivatepayload', async () => {
  const job = await done(account)
  await env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.userId).run()
  expect(
    await row(
      'SELECT input_json,result_json,owner_id FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ input_json: null, result_json: null, owner_id: null })
  expect(
    await row(
      'SELECT owner_id,reserved_micros FROM ai_usage WHERE turn_id=?',
      job.id,
    ),
  ).toEqual({ owner_id: null, reserved_micros: 300000 })
  expect(
    (await row('SELECT state FROM generation_debits WHERE job_id=?', job.id))
      .state,
  ).toBe('used')
})
test('claimed_account_delete_does_not_restore_guest_trial', async () => {
  const g = await guest()
  await done(g.principal)
  await claimGuestUsage(p, user, await claimRequest(g.cookie))
  await env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.userId).run()
  expect(await row('SELECT owner_id FROM generation_claims')).toEqual({
    owner_id: null,
  })
  await expect(
    reserveGeneration(p, g.principal, input()),
  ).rejects.toMatchObject({ status: 409 })
})
test('completed_payload_expiry_never_regenerates', async () => {
  const g = await guest()
  const value = input()
  const job = await done(g.principal, value)
  await env.DB.prepare(
    "UPDATE generation_jobs SET expires_at='2000-01-01' WHERE id=?",
  )
    .bind(job.id)
    .run()
  expect(await readGeneration(p, g.principal, job.id)).toMatchObject({
    status: 'complete',
    errorCode: 'RESULT_EXPIRED',
  })
  expect(await reserveGeneration(p, g.principal, value)).toMatchObject({
    admitted: false,
    job: { id: job.id, errorCode: 'RESULT_EXPIRED' },
  })
  expect((await row('SELECT count(*) n FROM ai_usage')).n).toBe(1)
  expect(
    await row(
      'SELECT input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ input_json: null, result_json: null })
})
test('expired lease releases credit and cannot begin or complete', async () => {
  const g = await guest()
  const { job } = await reserveGeneration(p, g.principal, input())
  await env.DB.prepare(
    "UPDATE generation_jobs SET lease_until='2000-01-01' WHERE id=?",
  )
    .bind(job.id)
    .run()
  expect(await beginGenerationAttempt(p, g.principal, job.id)).toBe(false)
  expect(await readGeneration(p, g.principal, job.id)).toMatchObject({
    status: 'stale',
  })
  expect(await getGenerationQuota(p, g.principal)).toMatchObject({
    remaining: 2,
  })
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBe(300000)
})
test.each(['session', 'credential', 'settings'])(
  'current %s fence stops late completion and clears content',
  async (which) => {
    const { job } = await reserveGeneration(p, account, input())
    await beginGenerationAttempt(p, account, job.id)
    if (which === 'session')
      await env.DB.prepare('DELETE FROM session WHERE id=?')
        .bind(account.kind === 'account' ? account.sessionId : '')
        .run()
    else if (which === 'credential')
      await env.DB.prepare('UPDATE user SET credential_generation=1 WHERE id=?')
        .bind(user.userId)
        .run()
    else await updateSettings(p, user, { aiEnabled: false })
    await expect(
      completeGeneration(p, account, job.id, record),
    ).rejects.toMatchObject({
      status: which === 'session' || which === 'credential' ? 401 : 409,
    })
    expect(
      (await row('SELECT state FROM generation_debits WHERE job_id=?', job.id))
        .state,
    ).not.toBe('used')
  },
)
async function discussion() {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    "INSERT INTO owned_threads(id,owner_id,record_json,mutation_id,created_at,updated_at) VALUES(?,'alice','{}','m','now','now')",
  )
    .bind(id)
    .run()
  return reserveTurn(p, user, {
    threadId: id,
    requestId: crypto.randomUUID(),
    kind: 'reply',
    triggerCommentId: null,
  })
}
test('parallel_discussion_and_generation_budget counts current same ledger', async () => {
  p.env.aiDailySpendLimitUsd = 0.31
  const results = await Promise.allSettled([
    reserveGeneration(p, account, input()),
    discussion(),
    discussion(),
    discussion(),
  ])
  expect(
    results.filter((x) => x.status === 'fulfilled').length,
  ).toBeLessThanOrEqual(3)
  const sums = await row('SELECT sum(reserved_micros) spend FROM ai_usage')
  expect(sums.spend).toBeLessThanOrEqual(310000)
  expect(
    (
      await row(
        "SELECT (SELECT count(*) FROM generation_jobs WHERE status IN ('reserved','running'))+(SELECT count(*) FROM ai_turns WHERE status IN ('reserved','running')) n",
      )
    ).n,
  ).toBeLessThanOrEqual(3)
})
test('refinement retains both attempts/output/Fetch and only changes before model work', async () => {
  const { job } = await reserveGeneration(p, account, input())
  await beginGenerationAttempt(p, account, job.id)
  await refineGenerationReservation(p, account, job.id, 10000)
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBe(refinedReservation(10000))
  await expect(
    refineGenerationReservation(p, account, job.id, 1),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    refineGenerationReservation(p, account, job.id, 422049),
  ).rejects.toMatchObject({ status: 422 })
  await cancelGeneration(p, account, job.id)
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBe(refinedReservation(10000))
})
test('refinement and parallel admission stay within ceiling and honor larger operator estimate', async () => {
  p.env.aiDailySpendLimitUsd = 0.32
  const { job } = await reserveGeneration(p, account, input())
  await beginGenerationAttempt(p, account, job.id)
  await Promise.allSettled([
    refineGenerationReservation(p, account, job.id, 10000),
    discussion(),
    discussion(),
  ])
  expect(
    (await row('SELECT sum(reserved_micros) spend FROM ai_usage')).spend,
  ).toBeLessThanOrEqual(320000)
  expect(budget(p).worst).toBeGreaterThanOrEqual(10080)
  p.env.aiWorstCaseCostMicros = 20000
  expect(budget(p).worst).toBe(20000)
  p.env.aiWorstCaseCostMicros = 1000
})

test('claim before account admission cannot be skipped by omitting claim UI', async () => {
  const g = await guest()
  await done(g.principal)
  await done(g.principal)
  const resolved = await resolveGenerationPrincipal(
    p,
    await claimRequest(g.cookie),
    { createGuest: false },
  )
  expect(resolved.principal.kind).toBe('account')
  expect(await getGenerationQuota(p, resolved.principal)).toMatchObject({
    used: 2,
    remaining: 8,
  })
  const { job } = await reserveGeneration(p, resolved.principal, input())
  expect(
    (await row('SELECT owner_id FROM generation_jobs WHERE id=?', job.id))
      .owner_id,
  ).toBe('alice')
})
test('claimed completed guest content is scrubbed when claiming account is deleted', async () => {
  const g = await guest()
  const job = await done(g.principal)
  await claimGuestUsage(p, user, await claimRequest(g.cookie))
  await env.DB.prepare('DELETE FROM user WHERE id=?').bind(user.userId).run()
  expect(
    await row(
      'SELECT input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ input_json: null, result_json: null })
  expect((await row('SELECT count(*) n FROM generation_claims')).n).toBe(1)
})
test('ownership, saved optout and invalid notice fail closed', async () => {
  const g = await guest(),
    other = await guest()
  const { job } = await reserveGeneration(p, g.principal, input())
  await expect(
    readGeneration(p, other.principal, job.id),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    cancelGeneration(p, other.principal, job.id),
  ).rejects.toMatchObject({ status: 404 })
  await updateSettings(p, user, { aiEnabled: false })
  await expect(reserveGeneration(p, account, input())).rejects.toMatchObject({
    status: 403,
  })
  await expect(
    reserveGeneration(p, other.principal, {
      ...input(),
      noticeVersion: 'obsolete',
    }),
  ).rejects.toMatchObject({ status: 400 })
  expect((await row('SELECT count(*) n FROM generation_jobs')).n).toBe(1)
})
test('failed/cancelled/stale request identity cannot silently start another operation', async () => {
  const g = await guest(),
    value = input()
  const { job } = await reserveGeneration(p, g.principal, value)
  await cancelGeneration(p, g.principal, job.id)
  expect(await reserveGeneration(p, g.principal, value)).toMatchObject({
    admitted: false,
    job: { id: job.id, status: 'cancelled' },
  })
  await expect(
    refineGenerationReservation(p, g.principal, job.id, 1000),
  ).rejects.toMatchObject({ status: 409 })
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBe(300000)
})
test('addressed expired result stays private even with a full housekeeping batch', async () => {
  const g = await guest(),
    job = await done(g.principal)
  await env.DB.prepare(
    "UPDATE generation_jobs SET expires_at='2000-01-02' WHERE id=?",
  )
    .bind(job.id)
    .run()
  await env.DB.batch(
    Array.from({ length: 101 }, () => {
      const id = crypto.randomUUID()
      return env.DB.prepare(
        "INSERT INTO generation_jobs(id,principal_key,request_id,fingerprint,status,record_id,expires_at,lease_until,created_at,input_json,result_json) VALUES(?,?,?,'digest','complete',?,'2000-01-01','2000-01-01','2000-01-01','private','private')",
      ).bind(id, 'guest:' + id, id, crypto.randomUUID())
    }),
  )
  expect(await readGeneration(p, g.principal, job.id)).toMatchObject({
    status: 'complete',
    errorCode: 'RESULT_EXPIRED',
  })
  expect(
    await row(
      'SELECT input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ input_json: null, result_json: null })
})
