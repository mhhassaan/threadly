import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest'
import { applyMigration } from './migrations'
import { createAuth } from '../../src/server/auth/auth'
import * as generation from '../../src/server/thread-generation/api'
import * as data from '../../src/server/data/api'
import { refinedReservation } from '../../src/server/thread-generation/policy'
import type { Platform } from '../../src/server/platform'
import type {
  GenerationInput,
  GenerationStatus,
} from '../../src/lib/thread-generation'
import type { ThreadRecord } from '../../src/lib/thread'

const base = 'http://localhost:4198'
const noticeVersion = '2026-10-30-v1'
const migrations = import.meta.glob('../../drizzle/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const source =
  'The public synthetic garden trial measured soil moisture each morning. Mulched beds retained more water during the same dry week. The small trial did not establish results for other climates.'
const posts = [
  'A small garden trial compared soil moisture during one dry week.',
  'Mulched beds retained more water in the trial.',
  'The limited trial does not establish results for other climates.',
]
const completion = (
  content: unknown = { title: 'A measured garden trial', posts },
) =>
  Response.json({
    choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(content) } },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 80 },
  })
const input = (patch: Partial<GenerationInput> = {}): GenerationInput => ({
  requestId: crypto.randomUUID(),
  mode: 'text',
  source,
  depth: 'balanced',
  length: 'auto',
  noticeVersion,
  ...patch,
})
const request = (path: string, cookie = '', method = 'GET', body?: unknown) =>
  new Request(base + path, {
    method,
    headers: { origin: base, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const row = (sql: string, ...values: (string | number)[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .first<any>()
const jar = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ')
let platform: Platform
let auth: ReturnType<typeof createAuth>
let mail: { text: string }[]
let background: Promise<unknown>[]
let paid: string[]
let model: (body: string) => Promise<Response>
let discussionModel: (() => Promise<Response>) | undefined
let article: string
let fetchContent: string
function call(
  path: string,
  cookie = '',
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  const req = request(path, cookie, method, body)
  const name = new URL(req.url).pathname
  if (name === '/api/generation/identity')
    return generation.handleGenerationIdentity(req, platform)
  if (name === '/api/generation/claim')
    return generation.handleGenerationClaim(req, platform)
  if (name === '/api/generation/quota')
    return generation.handleGenerationQuota(req, platform)
  if (name === '/api/generation')
    return generation.handleGeneration(req, platform)
  if (name.startsWith('/api/generation/'))
    return generation.handleGenerationJob(
      req,
      platform,
      name.split('/').at(-1)!,
    )
  if (name === '/api/library') return data.handleLibrary(req, platform)
  if (name.startsWith('/api/threads/'))
    return data.handleThread(req, platform, name.split('/').at(-1)!)
  if (name === '/api/ai/turns')
    return data.handleAiTurns(req, platform, () => platform)
  throw Error('Unrecognized actual handler path')
}
const postAuth = (path: string, body: unknown, cookie = '') =>
  auth.handler(request('/api/auth/' + path, cookie, 'POST', body))
async function identity() {
  const response = await call('/api/generation/identity', '', 'POST', {
    noticeVersion,
  })
  expect(response.status).toBe(200)
  expect(paid).toHaveLength(0)
  return jar(response)
}
async function signup() {
  const person = {
    email: crypto.randomUUID() + '@example.invalid',
    name: 'Synthetic reader',
    password: crypto.randomUUID() + crypto.randomUUID(),
    aiProcessingNoticeVersion: noticeVersion,
  }
  expect((await postAuth('sign-up/email', person)).status).toBe(200)
  expect((await postAuth('sign-in/email', person)).status).toBe(403)
  await Promise.all(background)
  const link = mail.at(-1)!.text.match(/http[^\s]+/)![0]
  expect((await auth.handler(new Request(link))).status).toBe(302)
  const signed = await postAuth('sign-in/email', person)
  expect(signed.status).toBe(200)
  return { person, cookie: jar(signed) }
}
async function admit(cookie: string, value = input()) {
  const before = paid.length
  const response = await call('/api/generation', cookie, 'POST', value)
  expect(response.status).toBe(202)
  const job = (await response.json()) as GenerationStatus
  expect(job.status).toBe('reserved')
  expect(job.id).not.toBe(value.requestId)
  expect(paid).toHaveLength(before)
  expect(
    (await call('/api/generation?requestId=' + value.requestId, cookie)).status,
  ).toBe(200)
  expect((await call('/api/generation/' + job.id, cookie)).status).toBe(200)
  expect(paid).toHaveLength(before)
  return job
}
async function generate(cookie: string, value = input()) {
  const job = await admit(cookie, value)
  const response = await call('/api/generation/' + job.id, cookie, 'POST', {})
  expect(response.status).toBe(200)
  const complete = (await response.json()) as GenerationStatus
  expect(complete.status).toBe('complete')
  expect(complete.record!.id).not.toBe(job.id)
  expect(complete.record!.id).not.toBe(value.requestId)
  expect(complete.record!.posts).toEqual(posts)
  return complete.record!
}
async function quota(cookie: string) {
  return (await call('/api/generation/quota', cookie)).json() as Promise<any>
}
function delayedModel() {
  let entered!: () => void, release!: (r: Response) => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  model = async () => {
    entered()
    return new Promise<Response>((resolve) => {
      release = resolve
    })
  }
  return { started, release: () => release(completion()) }
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort())
    await applyMigration(env.DB, migrations[path])
})
beforeEach(async () => {
  for (const table of [
    'generation_debits',
    'generation_jobs',
    'generation_claims',
    'generation_guests',
    'user',
    'ai_usage',
    'rate_limit',
  ])
    await env.DB.prepare('DELETE FROM "' + table + '"').run()
  discussionModel = undefined
  mail = []
  background = []
  paid = []
  article = '<p>Subscribe to continue reading</p>'
  fetchContent = source
  platform = {
    db: env.DB,
    env: {
      authUrl: base,
      authSecret: 'synthetic-journey-secret-only-01234567890123456789',
      dev: true,
      emailTransport: 'capture',
      devMailUrl: 'http://localhost:4197',
      resendFrom: '',
      resendApiKey: '',
      deepseekApiKey: 'fake-only',
      aiEnabled: true,
      aiDailySpendLimitUsd: 100,
      aiWorstCaseCostMicros: 10080,
    },
    waitUntil(work) {
      background.push(work)
    },
  }
  auth = createAuth(platform)
  model = async () => completion()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url)
    if (target === 'http://localhost:4197/messages') {
      mail.push(JSON.parse(String(init?.body)))
      return Response.json({})
    }
    if (target === 'https://garden.example/article')
      return new Response(article, { headers: { 'content-type': 'text/html' } })
    if (target === 'https://api.deepseek.com/v1/tools/fetch') {
      paid.push('fetch')
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://garden.example/article',
      })
      return Response.json({ title: 'Garden', content: fetchContent })
    }
    if (target === 'https://api.deepseek.com/chat/completions') {
      const body = String(init?.body),
        value = JSON.parse(body)
      if (value.max_tokens === 1200) {
        paid.push('discussion')
        if (!discussionModel) throw Error('Unexpected discussion transport')
        return discussionModel()
      }
      paid.push('model')
      expect(value.model).toBe('deepseek-flash')
      expect(value.thinking).toEqual({ type: 'disabled' })
      expect(value.max_tokens).toBe(16384)
      const bytes = new TextEncoder().encode(body).byteLength
      expect(bytes + 2048).toBeLessThanOrEqual(422048)
      const job = await row(
        "SELECT id FROM generation_jobs WHERE status='running' ORDER BY created_at DESC LIMIT 1",
      )
      expect(
        (
          await row(
            'SELECT reserved_micros FROM ai_usage WHERE turn_id=?',
            job.id,
          )
        ).reserved_micros,
      ).toBe(refinedReservation(bytes))
      return model(body)
    }
    throw Error('Unrecognized outbound transport: ' + target)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

for (const used of [1, 2])
  test(
    'actual signup claims ' +
      used +
      ' guest successes once; account reaches ten and resets only at UTC day',
    async () => {
      const guest = await identity()
      const records: ThreadRecord[] = []
      for (let i = 0; i < used; i++) records.push(await generate(guest))
      if (used === 2)
        expect(
          (await call('/api/generation', guest, 'POST', input())).status,
        ).toBe(429)
      const account = await signup(),
        cookie = guest + '; ' + account.cookie
      const claimed = await call('/api/generation/claim', cookie, 'POST', {})
      expect(await claimed.json()).toMatchObject({
        limit: 10,
        used,
        remaining: 10 - used,
      })
      const before = paid.length
      await Promise.all([
        call('/api/generation/claim', cookie, 'POST', {}),
        call('/api/generation/claim', cookie, 'POST', {}),
      ])
      expect(await quota(cookie)).toMatchObject({ used, remaining: 10 - used })
      expect(paid).toHaveLength(before)
      expect((await call('/api/library', cookie)).status).toBe(200)
      expect(await (await call('/api/library', cookie)).json()).toMatchObject({
        threads: [],
      })
      const migrationId = crypto.randomUUID()
      const imported = await call('/api/library', cookie, 'POST', {
        migrationId,
        record: records[0],
      })
      expect(imported.status).toBe(201)
      const saved = (await imported.json()) as { id: string }
      expect(
        (
          await call('/api/library', cookie, 'POST', {
            migrationId,
            record: records[0],
          })
        ).status,
      ).toBe(201)
      expect(
        (await call('/api/threads/' + saved.id, cookie, 'DELETE', {})).status,
      ).toBe(204)
      expect(await quota(cookie)).toMatchObject({ used })
      expect(paid).toHaveLength(before)
      expect((await postAuth('sign-out', {}, account.cookie)).status).toBe(200)
      expect(
        (await call('/api/generation', guest, 'POST', input())).status,
      ).toBe(409)
      const secondSession = jar(await postAuth('sign-in/email', account.person))
      const again = guest + '; ' + secondSession
      expect(
        await (await call('/api/generation/claim', again, 'POST', {})).json(),
      ).toMatchObject({ used })
      for (let i = used; i < 10; i++) await generate(again)
      expect(await quota(again)).toMatchObject({ used: 10, remaining: 0 })
      expect(
        (await call('/api/generation', again, 'POST', input())).status,
      ).toBe(429)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 86400000)
      expect(await quota(again)).toMatchObject({ used: 0, remaining: 10 })
      expect(
        await (await call('/api/generation/claim', again, 'POST', {})).json(),
      ).toMatchObject({ used: 0, remaining: 10 })
      // Claimed identity remains blocked across UTC boundaries and signout.
      expect(
        (await call('/api/generation', guest, 'POST', input())).status,
      ).toBe(409)
    },
  )

test('guest lifetime does not reset across UTC days; malformed result releases user slot but retains spend', async () => {
  const guest = await identity()
  model = async () => completion({ title: 'Invalid', posts: [''] })
  const bad = await admit(guest)
  expect(
    await (await call('/api/generation/' + bad.id, guest, 'POST', {})).json(),
  ).toMatchObject({ status: 'failed', errorCode: 'INVALID_GENERATED_THREAD' })
  expect(await quota(guest)).toMatchObject({
    used: 0,
    reserved: 0,
    remaining: 2,
  })
  expect(
    await row(
      'SELECT input_json,result_json FROM generation_jobs WHERE id=?',
      bad.id,
    ),
  ).toEqual({ input_json: null, result_json: null })
  const spend = (await row('SELECT sum(reserved_micros) n FROM ai_usage')).n
  expect(spend).toBeGreaterThan(0)
  model = async () => completion()
  await generate(guest)
  await generate(guest)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 2 * 86400000)
  expect(await quota(guest)).toMatchObject({
    used: 2,
    remaining: 0,
    resetAt: null,
  })
  expect((await call('/api/generation', guest, 'POST', input())).status).toBe(
    429,
  )
})

for (const winner of ['claim', 'completion'])
  test(
    'actual delayed provider versus verified claim: ' +
      winner +
      ' wins exactly once',
    async () => {
      const guest = await identity(),
        account = await signup()
      const job = await admit(guest),
        delayed = delayedModel()
      const executing = call('/api/generation/' + job.id, guest, 'POST', {})
      await delayed.started
      if (winner === 'completion') {
        delayed.release()
        expect((await executing).status).toBe(200)
      }
      const cookie = guest + '; ' + account.cookie
      const claims = await Promise.all([
        call('/api/generation/claim', cookie, 'POST', {}),
        call('/api/generation/claim', cookie, 'POST', {}),
      ])
      expect(claims.every((r) => r.status === 200)).toBe(true)
      if (winner === 'claim') {
        delayed.release()
        expect((await executing).status).toBeGreaterThanOrEqual(400)
      }
      expect(await quota(cookie)).toMatchObject({
        used: winner === 'claim' ? 0 : 1,
        reserved: 0,
        remaining: winner === 'claim' ? 10 : 9,
      })
      expect((await row('SELECT count(*) n FROM generation_claims')).n).toBe(1)
      expect(
        (await row('SELECT sum(reserved_micros) n FROM ai_usage')).n,
      ).toBeGreaterThan(0)
      expect(paid).toEqual(['model'])
      if (winner === 'claim')
        expect(
          await row(
            'SELECT status,input_json,result_json FROM generation_jobs WHERE id=?',
            job.id,
          ),
        ).toEqual({ status: 'cancelled', input_json: null, result_json: null })
    },
  )

test('cancel during outbound work releases credit, retains money and cannot publish; duplicate execution has one winner', async () => {
  const guest = await identity(),
    job = await admit(guest),
    delayed = delayedModel()
  const first = call('/api/generation/' + job.id, guest, 'POST', {})
  await delayed.started
  expect(
    (await call('/api/generation/' + job.id, guest, 'POST', {})).status,
  ).toBe(202)
  expect(
    (await call('/api/generation/' + job.id, guest, 'DELETE', {})).status,
  ).toBe(200)
  delayed.release()
  expect(await (await first).json()).toMatchObject({ status: 'cancelled' })
  expect(await quota(guest)).toMatchObject({
    used: 0,
    reserved: 0,
    remaining: 2,
  })
  expect(paid).toEqual(['model'])
  expect(
    (await row('SELECT reserved_micros FROM ai_usage WHERE turn_id=?', job.id))
      .reserved_micros,
  ).toBeGreaterThan(0)
  expect(
    await row(
      'SELECT status,input_json,result_json FROM generation_jobs WHERE id=?',
      job.id,
    ),
  ).toEqual({ status: 'cancelled', input_json: null, result_json: null })
})

test('actual URL extraction first, Fetch recovery once, source wall refusal and explicit recovery', async () => {
  const guest = await identity()
  article =
    '<html><head><title>Garden</title><meta property="og:image" content="https://garden.example/photo.png"></head><body><article><p>' +
    source +
    '</p></article></body></html>'
  const full = await generate(
    guest,
    input({ mode: 'url', source: 'https://garden.example/article' }),
  )
  expect(full.sourceText).toContain('Mulched beds')
  expect(full.sourceUrl).toBe('https://garden.example/article')
  expect(full.media.length).toBeGreaterThan(0)
  expect(paid).toEqual(['model'])
  article = '<p>Subscribe to continue reading</p>'
  fetchContent = 'Subscribe to continue reading the full article'
  const failed = await admit(
    guest,
    input({ mode: 'url', source: 'https://garden.example/article' }),
  )
  expect(
    await (
      await call('/api/generation/' + failed.id, guest, 'POST', {})
    ).json(),
  ).toMatchObject({ status: 'failed', errorCode: 'SOURCE_UNAVAILABLE' })
  expect(paid).toEqual(['model', 'fetch'])
  expect(await quota(guest)).toMatchObject({ used: 1, remaining: 1 })
  fetchContent = source
  const recovered = await generate(
    guest,
    input({ mode: 'url', source: 'https://garden.example/article' }),
  )
  expect(recovered.sourceText).toBe(source)
  expect(paid).toEqual(['model', 'fetch', 'fetch', 'model'])
})

async function savedThread(cookie: string) {
  const record: ThreadRecord = {
    id: crypto.randomUUID(),
    title: 'Garden',
    posts,
    sourceText: source,
    sourceUrl: '',
    source: null,
    media: [],
    interactions: {},
  }
  const response = await call('/api/library', cookie, 'POST', { record })
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}
function discussion(cookie: string, threadId: string) {
  return call('/api/ai/turns', cookie, 'POST', {
    threadId,
    requestId: crypto.randomUUID(),
    kind: 'opening',
    triggerCommentId: null,
  })
}

test('actual discussion and generation admissions race at shared money ceiling without overspending', async () => {
  const account = await signup(),
    cookie = account.cookie
  const thread = await savedThread(cookie)
  platform.env.aiDailySpendLimitUsd = 0.3
  discussionModel = async () => completion({ comments: [], memoryUpdates: [] })
  const responses = await Promise.all([
    call('/api/generation', cookie, 'POST', input()),
    discussion(cookie, thread),
  ])
  expect(responses.filter((r) => r.ok)).toHaveLength(1)
  expect(responses.find((r) => !r.ok)!.status).toBe(429)
  expect(
    ((await responses.find((r) => !r.ok)!.json()) as { code: string }).code,
  ).toMatch(/^(AI_LIMIT_REACHED|GENERATION_LIMIT_REACHED)$/)
  const ledger = await row(
    'SELECT sum(reserved_micros) spend,count(*) n FROM ai_usage',
  )
  expect(ledger.n).toBe(1)
  expect(ledger.spend).toBeLessThanOrEqual(300000)
  expect(paid.filter((x) => x === 'model')).toHaveLength(0)
})

test('actual account handlers enforce three combined active operations and one generation', async () => {
  const account = await signup(),
    cookie = account.cookie
  const threads = await Promise.all([
    savedThread(cookie),
    savedThread(cookie),
    savedThread(cookie),
  ])
  let entered = 0,
    ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const release: ((r: Response) => void)[] = []
  discussionModel = async () => {
    if (++entered === 2) ready()
    return new Promise<Response>((resolve) => release.push(resolve))
  }
  const turns = [discussion(cookie, threads[0]), discussion(cookie, threads[1])]
  await Promise.race([
    started,
    ...turns.map(async (result) => {
      const response = await result
      throw Error(
        'Discussion settled before both transports: ' +
          response.status +
          ' ' +
          (await response.text()),
      )
    }),
  ])
  const job = await admit(cookie)
  expect((await call('/api/generation', cookie, 'POST', input())).status).toBe(
    409,
  )
  expect((await discussion(cookie, threads[2])).status).toBe(409)
  expect(
    (
      await row(
        "SELECT (SELECT count(*) FROM ai_turns WHERE status IN ('reserved','running'))+(SELECT count(*) FROM generation_jobs WHERE status IN ('reserved','running')) n",
      )
    ).n,
  ).toBe(3)
  expect(
    (await call('/api/generation/' + job.id, cookie, 'DELETE', {})).status,
  ).toBe(200)
  for (const finish of release)
    finish(completion({ comments: [], memoryUpdates: [] }))
  expect((await Promise.all(turns)).every((r) => r.status === 200)).toBe(true)
  expect(await quota(cookie)).toMatchObject({
    used: 0,
    reserved: 0,
    remaining: 10,
  })
})

for (const reason of ['signout', 'expiry'])
  test(
    'actual authenticated execution cannot publish after ' + reason,
    async () => {
      const account = await signup(),
        cookie = account.cookie
      const job = await admit(cookie),
        delayed = delayedModel()
      const executing = call('/api/generation/' + job.id, cookie, 'POST', {})
      await delayed.started
      if (reason === 'signout')
        expect((await postAuth('sign-out', {}, cookie)).status).toBe(200)
      else
        await env.DB.prepare('UPDATE session SET expires_at=?')
          .bind(Date.now() - 1000)
          .run()
      delayed.release()
      expect((await executing).status).toBe(401)
      expect(
        await row(
          'SELECT status,input_json,result_json FROM generation_jobs WHERE id=?',
          job.id,
        ),
      ).toEqual({ status: 'stale', input_json: null, result_json: null })
      expect(
        await row('SELECT state FROM generation_debits WHERE job_id=?', job.id),
      ).toEqual({ state: 'released' })
      expect(
        (
          await row(
            'SELECT reserved_micros FROM ai_usage WHERE turn_id=?',
            job.id,
          )
        ).reserved_micros,
      ).toBeGreaterThan(0)
      expect(paid).toEqual(['model'])
    },
  )
