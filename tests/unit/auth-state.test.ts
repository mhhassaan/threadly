import { expect, test } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  createAccountBoundary,
  draftKey,
  validateAuthForm,
  mapAccountUser,
} from '../../src/features/account/auth-state'

function storage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}

test('account_switch_drops_private_cache and keeps guest library', () => {
  const cache = new QueryClient(),
    drafts = storage()
  const boundary = createAccountBoundary(cache, drafts)
  cache.setQueryData(['account', 'alice', 'threads'], ['private'])
  cache.setQueryData(['account', 'bob', 'threads'], ['bob'])
  cache.setQueryData(['local-library'], ['guest'])
  drafts.setItem('threadly-library', 'guest entries')
  drafts.setItem(draftKey('alice', 'reply'), 'private draft')
  boundary.observe('alice')
  boundary.observe('bob')
  expect(cache.getQueryData(['account', 'alice', 'threads'])).toBeUndefined()
  expect(cache.getQueryData(['account', 'bob', 'threads'])).toEqual(['bob'])
  expect(cache.getQueryData(['local-library'])).toEqual(['guest'])
  expect(drafts.getItem('threadly-library')).toBe('guest entries')
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
})

test('expired-session retry retains current draft until explicit logout', () => {
  const cache = new QueryClient(),
    drafts = storage()
  const boundary = createAccountBoundary(cache, drafts)
  boundary.observe('alice')
  drafts.setItem(draftKey('alice', 'reply'), 'keep my thought')
  cache.setQueryData(['account', 'alice', 'thread'], 'private')
  boundary.observe(null)
  expect(cache.getQueryData(['account', 'alice', 'thread'])).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBe('keep my thought')
  boundary.observe('alice')
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBe('keep my thought')
  boundary.logout()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
})

test('logout cancels inflight private query before removing it', async () => {
  const cache = new QueryClient(),
    boundary = createAccountBoundary(cache, storage())
  let aborted = false
  boundary.observe('alice')
  const pending = cache
    .fetchQuery({
      queryKey: ['account', 'alice', 'slow'],
      queryFn: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve('late private response')
          })
        }),
    })
    .catch(() => undefined)
  boundary.logout()
  await pending
  expect(aborted).toBe(true)
  expect(cache.getQueryData(['account', 'alice', 'slow'])).toBeUndefined()
})

test('signup rejects mismatched passwords and invalid email', () => {
  expect(
    validateAuthForm('signup', {
      name: 'Ada',
      email: 'bad',
      password: 'long enough password',
      confirm: 'long enough password',
    }),
  ).toMatchObject({ field: 'email' })
  expect(
    validateAuthForm('signup', {
      name: 'Ada',
      email: 'ada@example.invalid',
      password: 'long enough password',
      confirm: 'different password',
    }),
  ).toMatchObject({ field: 'confirm' })
  expect(
    validateAuthForm('reset', { password: 'short', confirm: 'short' }),
  ).toMatchObject({ field: 'password' })
  expect(
    validateAuthForm('signup', {
      name: 'Ada',
      email: 'ada@example.invalid',
      password: 'long enough password',
      confirm: 'long enough password',
    }),
  ).toBeNull()
})

test('maps Better Auth client identity to approved account interface', () => {
  expect(
    mapAccountUser({ id: 'alice', name: 'Alice', emailVerified: true }),
  ).toEqual({ id: 'alice', name: 'Alice', verified: true })
  expect(mapAccountUser(null)).toBeNull()
})

test('email sign-in keeps the current page and unsaved source draft', async () => {
  // Better Auth returns redirect:true when callbackURL is supplied for verification.
  // The client must not navigate away and discard the current editor on sign-in.
  const { vi } = await import('vitest')
  const location = {
    href: 'http://127.0.0.1:4180/',
    origin: 'http://127.0.0.1:4180',
  }
  vi.stubGlobal('window', { location })
  vi.stubGlobal('fetch', async () =>
    Response.json({
      redirect: true,
      url: 'http://127.0.0.1:4180/account',
      user: { id: 'alice' },
    }),
  )
  try {
    const { authClient } =
      await import('../../src/features/account/auth-client')
    await authClient.signIn.email({
      email: 'alice@example.invalid',
      password: crypto.randomUUID(),
      callbackURL: 'http://127.0.0.1:4180/account',
    })
    expect(location.href).toBe('http://127.0.0.1:4180/')
  } finally {
    vi.unstubAllGlobals()
  }
})
