import { afterEach, expect, test, vi } from 'vitest'
import { sendAccountEmail } from '../../src/server/auth/email'
import type { Platform } from '../../src/server/platform'

const input = {
  to: 'recipient@example.invalid',
  subject: 'Account',
  html: '<p>Account</p>',
  text: 'Account',
  idempotencyKey: 'test-message',
}
const platform = (overrides = {}) =>
  ({
    env: {
      authUrl: 'https://threadly.example.invalid',
      authSecret: '',
      emailTransport: 'resend',
      resendFrom: 'Threadly <noreply@example.invalid>',
      resendApiKey: 'test-only-placeholder',
      ...overrides,
    },
    waitUntil() {},
  }) as unknown as Platform
afterEach(() => vi.restoreAllMocks())

// Catches a missing authorization/idempotency header or changed recipient/body at the transport boundary.
test('resend request uses HTTPS authorization, idempotency and both message formats', async () => {
  let request: Request | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    request = new Request(url, init)
    return Response.json({ id: 'local-fixture' })
  })
  await sendAccountEmail(platform(), input)
  expect(request?.url).toBe('https://api.resend.com/emails')
  expect(request?.headers.get('Authorization')).toBe(
    'Bearer test-only-placeholder',
  )
  expect(request?.headers.get('Idempotency-Key')).toBe('test-message')
  expect(await request?.json()).toEqual({
    from: 'Threadly <noreply@example.invalid>',
    to: ['recipient@example.invalid'],
    subject: 'Account',
    html: '<p>Account</p>',
    text: 'Account',
  })
})

test('resend errors reject without including private provider response', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('sensitive-provider-detail', { status: 429 }),
  )
  await expect(sendAccountEmail(platform(), input)).rejects.toThrow(
    'Email delivery failed (429)',
  )
})

test.each([
  {
    emailTransport: 'capture',
    dev: false,
    devMailUrl: 'http://127.0.0.1:4187',
  },
  {
    emailTransport: 'capture',
    dev: true,
    devMailUrl: 'https://capture.example.invalid',
  },
  {
    emailTransport: 'capture',
    dev: true,
    authUrl: 'https://threadly.example.invalid',
    devMailUrl: 'http://127.0.0.1:4187',
  },
  { resendApiKey: '' },
  { resendFrom: '' },
])(
  'unsafe or incomplete email config fails before fetch (%j)',
  async (config) => {
    const fake = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'))
    await expect(sendAccountEmail(platform(config), input)).rejects.toThrow()
    expect(fake).not.toHaveBeenCalled()
  },
)
