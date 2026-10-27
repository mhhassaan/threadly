import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createAuth } from '../../src/server/auth/auth'
import { requireUser } from '../../src/server/auth/session'
import type { Platform } from '../../src/server/platform'
import { applyAuthMigrations } from './migrations'
import { fetchApp } from './helpers'

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
async function verifiedLogin(person = credentials()) {
  expect((await post('sign-up/email', person)).ok).toBe(true)
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const response = await post('sign-in/email', person)
  expect(response.ok).toBe(true)
  return { person, cookie: jar(response) }
}
beforeAll(async () => {
  await applyAuthMigrations(env.DB)
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

// Catches bypassing the verification gate, permitting password login before verification, or exposing another account.
test('verification_required', async () => {
  const person = credentials()
  expect((await post('sign-up/email', person)).ok).toBe(true)
  expect((await post('sign-in/email', person)).status).toBe(403)
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const cookie = jar(await post('sign-in/email', person))
  const request = new Request(`${base}/api/sync`, { headers: { cookie } })
  const owner = await requireUser(request, platform)
  expect(owner.email).toBe(person.email)
  expect(owner.verified).toBe(true)
  expect(owner.userId).toEqual(expect.any(String))
  await env.DB.prepare('UPDATE "user" SET email_verified = 0 WHERE id = ?')
    .bind(owner.userId)
    .run()
  await expect(requireUser(request, platform)).rejects.toMatchObject({
    status: 403,
    code: 'EMAIL_VERIFICATION_REQUIRED',
  })
  const second = await verifiedLogin()
  const other = await requireUser(
    new Request(base, { headers: { cookie: second.cookie } }),
    platform,
  )
  expect(other.userId).not.toBe(owner.userId)
})

test('reset_token_single_use', async () => {
  const { person, cookie } = await verifiedLogin()
  const secondCookie = jar(await post('sign-in/email', person))
  expect(
    (
      await post('request-password-reset', {
        email: person.email,
        redirectTo: `${base}/account/reset`,
      })
    ).ok,
  ).toBe(true)
  const resetUrl = await link()
  const resetResponse = await auth.handler(new Request(resetUrl))
  const token = new URL(
    resetResponse.headers.get('location')!,
  ).searchParams.get('token')
  expect(token).toBeTruthy()
  const replacement = crypto.randomUUID() + crypto.randomUUID()
  expect(
    (await post('reset-password', { token, newPassword: replacement })).ok,
  ).toBe(true)
  expect(
    (await post('reset-password', { token, newPassword: crypto.randomUUID() }))
      .ok,
  ).toBe(false)
  for (const oldCookie of [cookie, secondCookie])
    await expect(
      requireUser(
        new Request(base, { headers: { cookie: oldCookie } }),
        platform,
      ),
    ).rejects.toMatchObject({ status: 401 })
  expect((await post('sign-in/email', person)).ok).toBe(false)
  expect(
    (await post('sign-in/email', { ...person, password: replacement })).ok,
  ).toBe(true)
  await post('request-password-reset', {
    email: person.email,
    redirectTo: `${base}/account/reset`,
  })
  const expiredResponse = await auth.handler(new Request(await link()))
  const expiredToken = new URL(
    expiredResponse.headers.get('location')!,
  ).searchParams.get('token')
  await env.DB.prepare('UPDATE verification SET expires_at = 0').run()
  expect(
    (
      await post('reset-password', {
        token: expiredToken,
        newPassword: crypto.randomUUID(),
      })
    ).ok,
  ).toBe(false)
})

test('resend_failure_not_verified', async () => {
  platform.env = {
    ...platform.env,
    emailTransport: 'resend',
    resendFrom: 'Threadly <noreply@example.invalid>',
    resendApiKey: 'test-only-placeholder',
  }
  auth = createAuth(platform)
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }))
  const person = credentials()
  await post('sign-up/email', person)
  await Promise.allSettled(background)
  const user = await env.DB.prepare(
    'SELECT email_verified FROM "user" WHERE email = ?',
  )
    .bind(person.email)
    .first<{ email_verified: number }>()
  expect(user?.email_verified).toBe(0)
  expect((await post('sign-in/email', person)).status).toBe(403)
})

test('auth_trusted_origin', async () => {
  expect(
    (
      await post(
        'sign-up/email',
        credentials(),
        '',
        'https://attacker.example.invalid',
      )
    ).status,
  ).toBe(403)
  const { person } = await verifiedLogin()
  expect(
    (
      await post('request-password-reset', {
        email: person.email,
        redirectTo: 'https://attacker.example.invalid/reset',
      })
    ).status,
  ).toBe(403)
})

test('expired_session', async () => {
  const { cookie } = await verifiedLogin()
  await env.DB.prepare('UPDATE session SET expires_at = 0').run()
  await expect(
    requireUser(new Request(base, { headers: { cookie } }), platform),
  ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
})

test('production authentication fails closed without a strong secret', () => {
  expect(() =>
    createAuth({
      ...platform,
      env: {
        ...platform.env,
        dev: false,
        authUrl: 'https://threadly.example.invalid',
        authSecret: '',
      },
    }),
  ).toThrow()
})

test('database request limits persist across auth instances', async () => {
  const body = {
    email: 'missing@example.invalid',
    redirectTo: `${base}/account/reset`,
  }
  for (let i = 0; i < 5; i++) {
    auth = createAuth(platform)
    expect((await post('request-password-reset', body)).status).toBe(200)
  }
  auth = createAuth(platform)
  const limited = await post('request-password-reset', body)
  expect(limited.status).toBe(429)
  expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0)
})

test('production sessions use Secure HttpOnly SameSite cookies', async () => {
  const origin = 'https://threadly.example.invalid'
  platform.env = {
    ...platform.env,
    dev: false,
    authUrl: origin,
    emailTransport: 'resend',
    resendFrom: 'Threadly <noreply@example.invalid>',
    resendApiKey: 'test-only-placeholder',
  }
  auth = createAuth(platform)
  const person = credentials()
  const request = (path: string) =>
    new Request(`${origin}/api/auth/${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(person),
    })
  expect((await auth.handler(request('sign-up/email'))).ok).toBe(true)
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const signedIn = await auth.handler(request('sign-in/email'))
  expect(signedIn.ok).toBe(true)
  const cookies = signedIn.headers.getSetCookie().join('; ')
  expect(cookies).toContain('__Secure-')
  expect(cookies).toMatch(/; Secure/i)
  expect(cookies).toMatch(/; HttpOnly/i)
  expect(cookies).toMatch(/; SameSite=Lax/i)
})

test('auth_http_route', async () => {
  vi.mocked(fetch).mockRestore()
  const session = await fetchApp('/api/auth/get-session')
  expect(session.status).toBe(200)
  expect(await session.json()).toBeNull()
  const mutation = await fetchApp('/api/auth/sign-up/email', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.example.invalid',
      'content-type': 'application/json',
    },
    body: JSON.stringify(credentials()),
  })
  expect(mutation.status).toBe(403)
})

// Pauses exactly where pinned Better Auth has read the old credential but has not issued a session.
// Distinct auth instances model independent Workers sharing D1; no in-memory lock can satisfy this fence.
test('reset_fences_old_password_sign_in_across_workers', async () => {
  const { person, cookie: existingCookie } = await verifiedLogin()
  const signingIn = createAuth(platform)
  const context = await signingIn.$context
  const originalVerify = context.password.verify
  let resume!: () => void
  let reachedVerification!: () => void
  const paused = new Promise<void>((resolve) => (reachedVerification = resolve))
  const released = new Promise<void>((resolve) => (resume = resolve))
  context.password.verify = async (input) => {
    reachedVerification()
    await released
    return originalVerify(input)
  }
  const pendingSignIn = signingIn.handler(
    new Request(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(person),
    }),
  )
  await paused
  try {
    auth = createAuth(platform)
    await post('request-password-reset', {
      email: person.email,
      redirectTo: `${base}/account/reset`,
    })
    const resetResponse = await auth.handler(new Request(await link()))
    const token = new URL(
      resetResponse.headers.get('location')!,
    ).searchParams.get('token')
    const replacement = crypto.randomUUID() + crypto.randomUUID()
    expect(
      (await post('reset-password', { token, newPassword: replacement }))
        .status,
    ).toBe(200)
  } finally {
    resume()
  }
  const lateResponse = await pendingSignIn
  expect(lateResponse.status).toBe(401)
  expect(jar(lateResponse)).toBe('')
  for (const cookie of [existingCookie, jar(lateResponse)]) {
    const freshWorker = createAuth(platform)
    const sessionResponse = await freshWorker.handler(
      new Request(`${base}/api/auth/get-session`, { headers: { cookie } }),
    )
    expect(sessionResponse.status).toBe(200)
    expect(Boolean(await sessionResponse.json())).toBe(false)
    await expect(
      requireUser(new Request(base, { headers: { cookie } }), platform),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
  }
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS count FROM session').first<{
        count: number
      }>()
    )?.count,
  ).toBe(0)
})

test('reset_fences_session_inserted_before_password_write', async () => {
  const { person } = await verifiedLogin()
  await post('request-password-reset', {
    email: person.email,
    redirectTo: `${base}/account/reset`,
  })
  const resetResponse = await auth.handler(new Request(await link()))
  const token = new URL(
    resetResponse.headers.get('location')!,
  ).searchParams.get('token')
  const resetting = createAuth(platform)
  const context = await resetting.$context
  const originalUpdate = context.internalAdapter.updatePassword
  let resume!: () => void
  let reachedWrite!: () => void
  const paused = new Promise<void>((resolve) => (reachedWrite = resolve))
  const released = new Promise<void>((resolve) => (resume = resolve))
  context.internalAdapter.updatePassword = async (...args) => {
    reachedWrite()
    await released
    return originalUpdate(...args)
  }
  const replacement = crypto.randomUUID() + crypto.randomUUID()
  const pendingReset = resetting.handler(
    new Request(`${base}/api/auth/reset-password`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword: replacement }),
    }),
  )
  await paused
  let cookie = ''
  try {
    auth = createAuth(platform)
    const concurrentSignIn = await post('sign-in/email', person)
    expect(concurrentSignIn.status).toBe(200)
    cookie = jar(concurrentSignIn)
    expect(Boolean(cookie)).toBe(true)
  } finally {
    resume()
  }
  expect((await pendingReset).status).toBe(200)
  const freshWorker = createAuth(platform)
  const session = await freshWorker.handler(
    new Request(`${base}/api/auth/get-session`, { headers: { cookie } }),
  )
  expect(Boolean(await session.json())).toBe(false)
  await expect(
    requireUser(new Request(base, { headers: { cookie } }), platform),
  ).rejects.toMatchObject({ status: 401 })
  auth = createAuth(platform)
  expect(
    (await post('sign-in/email', { ...person, password: replacement })).status,
  ).toBe(200)
})

test('credential_generation_is_server_only', async () => {
  const person = credentials()
  const signup = await post('sign-up/email', {
    ...person,
    credentialGeneration: 999,
  })
  expect(signup.status).toBe(200)
  const signupBody = (await signup.json()) as { user: Record<string, unknown> }
  expect(Object.hasOwn(signupBody.user, 'credentialGeneration')).toBe(false)
  expect((await auth.handler(new Request(await link()))).status).toBe(302)
  const signin = await post('sign-in/email', {
    ...person,
    credentialGeneration: 999,
  })
  expect(signin.status).toBe(200)
  const cookie = jar(signin)
  const response = await auth.handler(
    new Request(`${base}/api/auth/get-session`, { headers: { cookie } }),
  )
  const body = (await response.json()) as {
    user: Record<string, unknown>
    session: Record<string, unknown>
  }
  expect(Object.hasOwn(body.user, 'credentialGeneration')).toBe(false)
  expect(Object.hasOwn(body.session, 'credentialGeneration')).toBe(false)
  const owner = await requireUser(
    new Request(base, { headers: { cookie } }),
    platform,
  )
  expect(Object.keys(owner).sort()).toEqual([
    'email',
    'name',
    'userId',
    'verified',
  ])
  const generation = await env.DB.prepare(
    'SELECT u.credential_generation AS user_generation, s.credential_generation AS session_generation FROM "user" u JOIN session s ON s.user_id = u.id WHERE u.id = ?',
  )
    .bind(owner.userId)
    .first()
  expect(generation).toEqual({ user_generation: 0, session_generation: 0 })
})

test('d1_atomically_rejects_stale_session_generation', async () => {
  const { cookie } = await verifiedLogin()
  const owner = await requireUser(
    new Request(base, { headers: { cookie } }),
    platform,
  )
  const replacementHash = await (
    await auth.$context
  ).password.hash(crypto.randomUUID() + crypto.randomUUID())
  await env.DB.prepare(
    'UPDATE account SET password = ? WHERE user_id = ? AND provider_id = ?',
  )
    .bind(replacementHash, owner.userId, 'credential')
    .run()
  const generation = await env.DB.prepare(
    'SELECT credential_generation FROM "user" WHERE id = ?',
  )
    .bind(owner.userId)
    .first<{ credential_generation: number }>()
  expect(generation?.credential_generation).toBe(1)
  const now = Date.now()
  await expect(
    env.DB.prepare(
      'INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at, credential_generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        owner.userId,
        now + 60000,
        now,
        now,
        0,
      )
      .run(),
  ).rejects.toThrow('Stale credential generation')
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS count FROM session').first<{
        count: number
      }>()
    )?.count,
  ).toBe(0)
})
