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
  handleGeneration,
  handleGenerationJob,
  handleGenerationQuota,
  handleGenerationClaim,
  handleGenerationIdentity,
} from '../../src/server/thread-generation/api'
import type { Platform } from '../../src/server/platform'
import type {
  GenerationInput,
  GenerationStatus,
} from '../../src/lib/thread-generation'
const base = 'http://localhost:4176'
const noticeVersion = '2026-10-30-v1'
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
  },
  waitUntil() {
    throw Error('long work must be awaited')
  },
}
const input = (
  source = 'Public synthetic evidence with complete supported facts.',
): GenerationInput => ({
  requestId: crypto.randomUUID(),
  mode: 'text',
  source,
  depth: 'balanced',
  length: 'auto',
  noticeVersion,
})
const req = (
  path: string,
  method = 'GET',
  value?: unknown,
  cookie = '',
  signal?: AbortSignal,
) =>
  new Request(base + path, {
    method,
    headers: { origin: base, 'content-type': 'application/json', cookie },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal,
  })
const row = (sql: string, ...values: (string | number | null)[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first<any>()
const result = () =>
  Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: 'Evidence',
            posts: [
              'One supported complete thought.',
              'A second supported thought.',
            ],
          }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  })
let calls: string[] = []
let provider: (url: string, init?: RequestInit) => Promise<Response>
async function guest() {
  const r = await handleGenerationIdentity(
    req('/api/generation/identity', 'POST', { noticeVersion }),
    p,
  )
  expect(r.status).toBe(200)
  return r.headers.get('set-cookie')!.split(';')[0]
}
async function authCookie(id = 'alice') {
  const token = id + '-token',
    key = await crypto.subtle.importKey(
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
async function generate(cookie: string, value = input(), signal?: AbortSignal) {
  const response = await handleGeneration(
    req('/api/generation', 'POST', value, cookie, signal),
    p,
  )
  if (response.status !== 202) return response
  const job = (await response.clone().json()) as GenerationStatus
  if (job.status !== 'reserved') return response
  return handleGenerationJob(
    req('/api/generation/' + job.id, 'POST', {}, cookie, signal),
    p,
    job.id,
  )
}
async function pending(cookie: string, value = input(), signal?: AbortSignal) {
  const admission = await handleGeneration(
    req('/api/generation', 'POST', value, cookie),
    p,
  )
  expect(admission.status).toBe(202)
  const job = (await admission.json()) as GenerationStatus
  let release!: (r: Response) => void, started!: () => void
  const ready = new Promise<void>((r) => (started = r))
  provider = async () => {
    started()
    return new Promise<Response>((r) => (release = r))
  }
  const response = handleGenerationJob(
    req('/api/generation/' + job.id, 'POST', {}, cookie, signal),
    p,
    job.id,
  )
  await ready
  return { id: job.id, response, release }
}
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
  for (const s of [reading, turns, ui, opening, memory, privacy])
    await applyMigration(env.DB, s)
})
beforeEach(async () => {
  vi.useRealTimers()
  p.env.aiEnabled = true
  p.env.aiDailySpendLimitUsd = 100
  calls = []
  for (const table of [
    'generation_debits',
    'generation_jobs',
    'generation_claims',
    'generation_guests',
    'ai_usage',
    'user',
  ])
    await env.DB.prepare('DELETE FROM ' + table).run()
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,email_verified,created_at,updated_at,ai_processing_notice_version) VALUES(?,?,?,1,1,1,?)',
    )
      .bind(id, id, id + '@example.invalid', noticeVersion)
      .run()
    await env.DB.prepare(
      'INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,1,1)',
    )
      .bind(id + '-session', id, id + '-token', Date.now() + 864000000)
      .run()
  }
  provider = async () => result()
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    calls.push(String(url))
    return provider(String(url), init)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
test('identity bootstrap sets cookie without a job debit or provider call', async () => {
  const r = await handleGenerationIdentity(
    req('/api/generation/identity', 'POST', { noticeVersion }),
    p,
  )
  expect(r.status).toBe(200)
  expect(r.headers.get('cache-control')).toBe('private, no-store')
  expect(r.headers.get('set-cookie')).toContain(
    'HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000',
  )
  expect(await r.json()).toEqual({
    kind: 'guest',
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    resetAt: null,
  })
  expect(await row('SELECT count(*) n FROM generation_jobs')).toEqual({ n: 0 })
  expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 0 })
  expect(calls).toEqual([])
})
test('quota GET never creates a guest cookie', async () => {
  const r = await handleGenerationQuota(req('/api/generation/quota'), p)
  expect(r.status).toBe(401)
  expect(r.headers.get('set-cookie')).toBeNull()
  expect(await row('SELECT count(*) n FROM generation_guests')).toEqual({
    n: 0,
  })
  expect(calls).toEqual([])
})
test('generation requires already established identity', async () => {
  const r = await generate('')
  expect(r.status).toBe(401)
  expect(r.headers.get('set-cookie')).toBeNull()
  expect(calls).toEqual([])
})
test.each([
  ['missing notice', {}, 400],
  ['old notice', { noticeVersion: 'old' }, 400],
  ['extra field', { noticeVersion, source: 'private' }, 400],
])(
  'identity rejects %s without creating identity',
  async (_, value, status) => {
    const r = await handleGenerationIdentity(
      req('/api/generation/identity', 'POST', value),
      p,
    )
    expect(r.status).toBe(status)
    expect(await row('SELECT count(*) n FROM generation_guests')).toEqual({
      n: 0,
    })
    expect(calls).toEqual([])
  },
)
test.each([
  ['origin', 'https://evil.invalid', 403],
  ['content-type', 'text/plain', 415],
  ['content-length', '1048577', 413],
])('mutation enforces %s', async (header, value, status) => {
  const r = req('/api/generation/identity', 'POST', { noticeVersion })
  r.headers.set(header, value)
  const response = await handleGenerationIdentity(r, p)
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(calls).toEqual([])
})
test('chunked body and malformed JSON are bounded without provider work', async () => {
  for (const body of ['x', '"' + 'x'.repeat(1048577) + '"']) {
    const r = await handleGenerationIdentity(
      new Request(base + '/api/generation/identity', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body,
      }),
      p,
    )
    expect(r.status).toBe(body === 'x' ? 400 : 413)
  }
  expect(calls).toEqual([])
})
test('missing generation notice and unknown client identity cannot reach provider', async () => {
  const cookie = await guest()
  for (const value of [
    { ...input(), noticeVersion: '' },
    { ...input(), ownerId: 'bob' },
  ]) {
    const r = await generate(cookie, value)
    expect(r.status).toBe(400)
  }
  expect(calls).toEqual([])
  expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 0 })
})
test('successful text result preserves evidence media and stable record identity across duplicate POST and GET', async () => {
  const cookie = await guest(),
    value = input(
      'Evidence ![Chart](https://example.org/chart.png) shows a complete fact.',
    )
  const r = await generate(cookie, value)
  expect(r.status).toBe(200)
  const job = (await r.json()) as GenerationStatus
  expect(job.status).toBe('complete')
  expect(job.record?.id).not.toBe(job.id)
  expect(job.record?.posts).toEqual([
    'One supported complete thought.',
    'A second supported thought.',
  ])
  expect(job.record?.sourceText).toBe(value.source)
  expect(job.record?.media[0]).toMatchObject({
    url: 'https://example.org/chart.png',
    postIndex: 1,
  })
  const again = await generate(cookie, value)
  expect(again.status).toBe(200)
  expect(await again.json()).toEqual(job)
  const read = await handleGenerationJob(
    req('/api/generation/' + job.id, 'GET', undefined, cookie),
    p,
    job.id,
  )
  expect(await read.json()).toEqual(job)
  expect(calls).toEqual(['https://api.deepseek.com/chat/completions'])
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'used',
  })
  expect(await row('SELECT count(*) n FROM owned_threads')).toEqual({ n: 0 })
})
test('first guest cookie permits pending GET duplicate and cancellation before POST returns', async () => {
  const cookie = await guest(),
    value = input(),
    run = await pending(cookie, value)
  const duplicate = await generate(cookie, value)
  expect(duplicate.status).toBe(202)
  expect(((await duplicate.json()) as GenerationStatus).id).toBe(run.id)
  const read = await handleGenerationJob(
    req('/api/generation/' + run.id, 'GET', undefined, cookie),
    p,
    run.id,
  )
  expect(((await read.json()) as GenerationStatus).status).toBe('running')
  const cancelled = await handleGenerationJob(
    req('/api/generation/' + run.id, 'DELETE', {}, cookie),
    p,
    run.id,
  )
  expect(cancelled.status).toBe(200)
  run.release(result())
  const final = await run.response
  expect(((await final.json()) as GenerationStatus).status).toBe('cancelled')
  expect(calls).toHaveLength(1)
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'released',
  })
  expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 1 })
})
test('cross-principal status and cancellation return private 404', async () => {
  const cookie = await guest(),
    job = (await (await generate(cookie)).json()) as GenerationStatus,
    other = await guest()
  for (const method of ['GET', 'DELETE']) {
    const r = await handleGenerationJob(
      req(
        '/api/generation/' + job.id,
        method,
        method === 'DELETE' ? {} : undefined,
        other,
      ),
      p,
      job.id,
    )
    expect(r.status).toBe(404)
    expect(r.headers.get('cache-control')).toBe('private, no-store')
  }
})
test('invalid authenticated cookie never falls back to guest allowance', async () => {
  for (const handler of [handleGenerationIdentity, handleGeneration]) {
    const r = await handler(
      req(
        '/api/generation',
        'POST',
        handler === handleGenerationIdentity ? { noticeVersion } : input(),
        'better-auth.session_token=invalid',
      ),
      p,
    )
    expect(r.status).toBe(401)
  }
  expect(await row('SELECT count(*) n FROM generation_guests')).toEqual({
    n: 0,
  })
  expect(calls).toEqual([])
})
test('unverified account never acquires a guest identity', async () => {
  await env.DB.prepare('UPDATE user SET email_verified=0 WHERE id=?')
    .bind('alice')
    .run()
  const r = await handleGenerationIdentity(
    req(
      '/api/generation/identity',
      'POST',
      { noticeVersion },
      await authCookie(),
    ),
    p,
  )
  expect([401, 403]).toContain(r.status)
  expect(r.headers.get('set-cookie')).toBeNull()
  expect(await row('SELECT count(*) n FROM generation_guests')).toEqual({
    n: 0,
  })
})
test.each(['ai_enabled', 'consent_at'])(
  'account %s gate rejects provider work',
  async (field) => {
    const cookie = await authCookie()
    await handleGenerationIdentity(
      req('/api/generation/identity', 'POST', { noticeVersion }, cookie),
      p,
    )
    // Initialization occurs at admission; create then explicitly preserve an account opt-out.
    await env.DB.prepare(
      'INSERT OR IGNORE INTO account_settings(owner_id,ai_enabled,consent_at) VALUES(?,1,?)',
    )
      .bind('alice', new Date().toISOString())
      .run()
    await env.DB.prepare(
      'UPDATE account_settings SET ' + field + '=? WHERE owner_id=?',
    )
      .bind(field === 'ai_enabled' ? 0 : null, 'alice')
      .run()
    const r = await generate(cookie)
    expect(r.status).toBe(403)
    expect(calls).toEqual([])
  },
)
test('verified claim cancels pending guest and neither claim nor quota performs generation', async () => {
  const cookie = await guest(),
    run = await pending(cookie),
    account = cookie + '; ' + (await authCookie())
  const claim = await handleGenerationClaim(
    req('/api/generation/claim', 'POST', {}, account),
    p,
  )
  expect(claim.status).toBe(200)
  expect(await claim.json()).toMatchObject({
    kind: 'account',
    used: 0,
    remaining: 10,
  })
  run.release(result())
  expect((await run.response).status).toBe(409)
  expect(
    await row(
      'SELECT status,result_json,input_json FROM generation_jobs WHERE id=?',
      run.id,
    ),
  ).toEqual({ status: 'cancelled', result_json: null, input_json: null })
  expect(calls).toHaveLength(1)
  const quota = await handleGenerationQuota(
    req('/api/generation/quota', 'GET', undefined, account),
    p,
  )
  expect(quota.status).toBe(200)
  expect(quota.headers.get('set-cookie')).toBeNull()
  expect(calls).toHaveLength(1)
})
test('completed guest usage is claimed once through real API', async () => {
  const cookie = await guest()
  await generate(cookie)
  const account = cookie + '; ' + (await authCookie())
  for (let i = 0; i < 2; i++) {
    const r = await handleGenerationClaim(
      req('/api/generation/claim', 'POST', {}, account),
      p,
    )
    expect(await r.json()).toMatchObject({
      kind: 'account',
      used: 1,
      remaining: 9,
    })
  }
  expect(calls).toHaveLength(1)
})
test.each(['signout', 'revoke', 'delete', 'pause', 'consent', 'epoch'])(
  '%s while provider is delayed fences publication',
  async (change) => {
    const run = await pending(await authCookie())
    const sql = {
      signout: "DELETE FROM session WHERE user_id='alice'",
      revoke:
        "UPDATE user SET credential_generation=credential_generation+1 WHERE id='alice'",
      delete: "DELETE FROM user WHERE id='alice'",
      pause: "UPDATE account_settings SET ai_enabled=0 WHERE owner_id='alice'",
      consent:
        "UPDATE account_settings SET consent_at=NULL WHERE owner_id='alice'",
      epoch:
        "UPDATE account_settings SET settings_epoch=settings_epoch+1 WHERE owner_id='alice'",
    }[change]!
    await env.DB.prepare(sql).run()
    run.release(result())
    const response = await run.response
    expect([200, 401, 409]).toContain(response.status)
    const job = await row(
      'SELECT status,result_json,input_json FROM generation_jobs WHERE id=?',
      run.id,
    )
    expect(job?.result_json ?? null).toBeNull()
    expect(job?.input_json ?? null).toBeNull()
    expect(job?.status).not.toBe('complete')
    expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 1 })
  },
)
test('request abort releases credit and rejects late provider output', async () => {
  const cookie = await guest(),
    controller = new AbortController(),
    run = await pending(cookie, input(), controller.signal)
  controller.abort()
  run.release(result())
  const response = await run.response
  expect(((await response.json()) as GenerationStatus).status).toBe('cancelled')
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'released',
  })
})
test('invalid model output releases credit but retains spend and clears private payload', async () => {
  const cookie = await guest()
  provider = async () =>
    Response.json({
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
    })
  const r = await generate(cookie)
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({ status: 'failed' })
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'released',
  })
  expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 1 })
  expect(
    await row('SELECT input_json,result_json FROM generation_jobs'),
  ).toEqual({ input_json: null, result_json: null })
})
test('GET expires the result without restarting or refunding completed usage', async () => {
  const cookie = await guest(),
    value = input(),
    job = (await (await generate(cookie, value)).json()) as GenerationStatus
  await env.DB.prepare('UPDATE generation_jobs SET expires_at=? WHERE id=?')
    .bind('2000-01-01T00:00:00.000Z', job.id)
    .run()
  const r = await handleGenerationJob(
    req('/api/generation/' + job.id, 'GET', undefined, cookie),
    p,
    job.id,
  )
  expect(await r.json()).toMatchObject({
    status: 'complete',
    errorCode: 'RESULT_EXPIRED',
  })
  expect(
    ((await (await generate(cookie, value)).json()) as GenerationStatus).record,
  ).toBeUndefined()
  expect(calls).toHaveLength(1)
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'used',
  })
  expect(await row('SELECT count(*) n FROM ai_usage')).toEqual({ n: 1 })
})

test('cancel after local retrieval prevents paid Fetch fallback', async () => {
  const cookie = await guest(),
    value = { ...input('https://example.org/story'), mode: 'url' as const },
    run = await pending(cookie, value)
  const cancelled = await handleGenerationJob(
    req('/api/generation/' + run.id, 'DELETE', {}, cookie),
    p,
    run.id,
  )
  expect(cancelled.status).toBe(200)
  run.release(
    new Response('<html><body>Unavailable</body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  )
  expect(((await (await run.response).json()) as GenerationStatus).status).toBe(
    'cancelled',
  )
  expect(calls).toEqual(['https://example.org/story'])
})
test('cancel after first model error prevents a second paid attempt', async () => {
  const cookie = await guest(),
    run = await pending(cookie)
  await handleGenerationJob(
    req('/api/generation/' + run.id, 'DELETE', {}, cookie),
    p,
    run.id,
  )
  run.release(new Response('Unavailable', { status: 503 }))
  expect(((await (await run.response).json()) as GenerationStatus).status).toBe(
    'cancelled',
  )
  expect(calls).toEqual(['https://api.deepseek.com/chat/completions'])
})
test('periodic current job check aborts a noncooperative provider after DELETE', async () => {
  const cookie = await guest(),
    run = await pending(cookie)
  await handleGenerationJob(
    req('/api/generation/' + run.id, 'DELETE', {}, cookie),
    p,
    run.id,
  )
  const response = await run.response
  expect(((await response.json()) as GenerationStatus).status).toBe('cancelled')
  expect(calls).toHaveLength(1)
  run.release(result())
})
test('overall POST deadline bounds a stalled body and cancels its stream', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const request = new Request(base + '/api/generation', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: stream,
  })
  const response = handleGenerationJob(
    request,
    p,
    '00000000-0000-4000-8000-000000000001',
  )
  await vi.advanceTimersByTimeAsync(120000)
  expect((await response).status).toBe(408)
  expect(cancelled).toBe(true)
  expect(calls).toEqual([])
})
test('expired lease GET retires the job without provider work or restart', async () => {
  const cookie = await guest(),
    run = await pending(cookie)
  await env.DB.prepare('UPDATE generation_jobs SET lease_until=? WHERE id=?')
    .bind('2000-01-01T00:00:00.000Z', run.id)
    .run()
  const r = await handleGenerationJob(
    req('/api/generation/' + run.id, 'GET', undefined, cookie),
    p,
    run.id,
  )
  expect(await r.json()).toMatchObject({
    status: 'stale',
    errorCode: 'LEASE_EXPIRED',
  })
  run.release(result())
  expect(((await (await run.response).json()) as GenerationStatus).status).toBe(
    'stale',
  )
  expect(calls).toHaveLength(1)
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'released',
  })
})

test('admission returns a known job UUID without starting provider work', async () => {
  const cookie = await guest(),
    value = input()
  const response = await handleGeneration(
    req('/api/generation', 'POST', value, cookie),
    p,
  )
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({
    status: 'reserved',
    phase: 'preparing',
  })
  expect(calls).toEqual([])
  expect(await row('SELECT state FROM generation_debits')).toEqual({
    state: 'reserved',
  })
})
test('lost admission response is recovered by owned requestId GET without provider work', async () => {
  const cookie = await guest(),
    value = input()
  await handleGeneration(req('/api/generation', 'POST', value, cookie), p)
  const response = await handleGeneration(
    req(
      '/api/generation?requestId=' + value.requestId,
      'GET',
      undefined,
      cookie,
    ),
    p,
  )
  expect(response.status).toBe(200)
  const job = (await response.json()) as GenerationStatus
  expect(job.status).toBe('reserved')
  expect(job.id).not.toBe(value.requestId)
  expect(calls).toEqual([])
  const other = await guest(),
    hidden = await handleGeneration(
      req(
        '/api/generation?requestId=' + value.requestId,
        'GET',
        undefined,
        other,
      ),
      p,
    )
  expect(hidden.status).toBe(404)
})
test('duplicate explicit execution reads running and complete jobs without more provider calls', async () => {
  const cookie = await guest(),
    run = await pending(cookie)
  const duplicate = await handleGenerationJob(
    req('/api/generation/' + run.id, 'POST', {}, cookie),
    p,
    run.id,
  )
  expect(duplicate.status).toBe(202)
  expect(await duplicate.json()).toMatchObject({
    id: run.id,
    status: 'running',
  })
  run.release(result())
  const completed = await (await run.response).json()
  const replay = await handleGenerationJob(
    req('/api/generation/' + run.id, 'POST', {}, cookie),
    p,
    run.id,
  )
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual(completed)
  expect(calls).toHaveLength(1)
})
test('cancellation before explicit execution prevents every provider request', async () => {
  const cookie = await guest(),
    value = input(),
    admission = await handleGeneration(
      req('/api/generation', 'POST', value, cookie),
      p,
    ),
    job = (await admission.json()) as GenerationStatus
  await handleGenerationJob(
    req('/api/generation/' + job.id, 'DELETE', {}, cookie),
    p,
    job.id,
  )
  const run = await handleGenerationJob(
    req('/api/generation/' + job.id, 'POST', {}, cookie),
    p,
    job.id,
  )
  expect(await run.json()).toMatchObject({ id: job.id, status: 'cancelled' })
  expect(calls).toEqual([])
})
test('execution rejects replacement input and recovery strictly requires one UUID requestId', async () => {
  const cookie = await guest(),
    value = input(),
    job = (await (
      await handleGeneration(req('/api/generation', 'POST', value, cookie), p)
    ).json()) as GenerationStatus
  const replaced = await handleGenerationJob(
    req('/api/generation/' + job.id, 'POST', { source: 'Replacement' }, cookie),
    p,
    job.id,
  )
  expect(replaced.status).toBe(400)
  for (const query of [
    '',
    '?requestId=invalid',
    '?requestId=' + value.requestId + '&requestId=' + value.requestId,
    '?requestId=' + value.requestId + '&owner=bob',
  ]) {
    const r = await handleGeneration(
      req('/api/generation' + query, 'GET', undefined, cookie),
      p,
    )
    expect(r.status).toBe(400)
  }
  expect(calls).toEqual([])
})
test('identity reuse and signed-in bootstrap never create another guest allowance', async () => {
  const cookie = await guest(),
    reuse = await handleGenerationIdentity(
      req('/api/generation/identity', 'POST', { noticeVersion }, cookie),
      p,
    )
  expect(reuse.status).toBe(200)
  expect(reuse.headers.get('set-cookie')).toBeNull()
  const account = await handleGenerationIdentity(
    req(
      '/api/generation/identity',
      'POST',
      { noticeVersion },
      await authCookie(),
    ),
    p,
  )
  expect(await account.json()).toMatchObject({
    kind: 'account',
    limit: 10,
    remaining: 10,
  })
  expect(account.headers.get('set-cookie')).toBeNull()
  expect(await row('SELECT count(*) n FROM generation_guests')).toEqual({
    n: 1,
  })
  expect(calls).toEqual([])
})
test('execute uses admitted normalized input and refines reservation before the model request', async () => {
  const cookie = await guest(),
    value = input('  Literal evidence.\r\nSecond line.  ')
  const admission = await handleGeneration(
      req('/api/generation', 'POST', value, cookie),
      p,
    ),
    job = (await admission.json()) as GenerationStatus
  expect(
    await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id),
  ).toEqual({ reserved_micros: 300000 })
  provider = async (_url, init) => {
    const text = String(init?.body),
      payload = JSON.parse(text)
    expect(payload.messages[1].content).toContain(
      'Literal evidence.\\nSecond line.',
    )
    const bytes = new TextEncoder().encode(text).byteLength
    expect(
      await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id),
    ).toEqual({
      reserved_micros: Math.ceil(
        2 * ((bytes + 2048) * 0.3 + 16384 * 1.2) + 750,
      ),
    })
    return result()
  }
  const response = await handleGenerationJob(
    req('/api/generation/' + job.id, 'POST', {}, cookie),
    p,
    job.id,
  )
  expect(((await response.json()) as GenerationStatus).record?.sourceText).toBe(
    'Literal evidence.\nSecond line.',
  )
})
