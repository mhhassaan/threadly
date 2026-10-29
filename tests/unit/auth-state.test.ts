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

test.each(['reject', 'resolve'] as const)(
  'deferred Alice logout %s cannot replace Bob provider ownership',
  async (outcome) => {
    const { createAccountTransitions } =
      await import('../../src/features/account/account-transitions')
    const cache = new QueryClient(),
      drafts = storage(),
      boundary = createAccountBoundary(cache, drafts)
    let applied: string | null = null
    const broadcast: string[] = []
    const transitions = createAccountTransitions(boundary, {
      applied: (id) => {
        applied = id
      },
      expired() {},
      broadcast: (id) => {
        broadcast.push(id)
      },
    })
    transitions.apply('alice', 'alice-session')
    let rejectAlice!: (error: Error) => void
    let resolveAlice!: (value: { error: null }) => void
    const aliceRequest = new Promise<{ error?: unknown }>((resolve, reject) => {
      resolveAlice = resolve
      rejectAlice = reject
    })
    const aliceLogout = transitions
      .signOut(
        () => aliceRequest,
        async () => {},
      )
      .catch((error) => error)
    transitions.apply('bob', 'bob-session')
    cache.setQueryData(['account', 'bob', 'thread'], 'bob private')
    drafts.setItem(draftKey('bob', 'reply'), 'bob private draft')
    cache.setQueryData(['local-library'], ['guest'])
    drafts.setItem('threadly-library', 'guest records')
    if (outcome === 'reject') rejectAlice(new Error('old network failure'))
    else resolveAlice({ error: null })
    expect(await aliceLogout).toBeUndefined()
    expect(applied).toBe('bob')
    expect(boundary.owner()).toBe('bob')
    expect(cache.getQueryData(['account', 'bob', 'thread'])).toBe('bob private')
    expect(drafts.getItem(draftKey('bob', 'reply'))).toBe('bob private draft')
    await transitions.signOut(
      async () => ({ error: null }),
      async () => {},
    )
    expect(cache.getQueryData(['account', 'bob', 'thread'])).toBeUndefined()
    expect(drafts.getItem(draftKey('bob', 'reply'))).toBeNull()
    expect(cache.getQueryData(['local-library'])).toEqual(['guest'])
    expect(drafts.getItem('threadly-library')).toBe('guest records')
    expect(broadcast).toEqual(['alice', 'bob'])
  },
)

test('provider hides pending logout owner and clears late private refill on completion', async () => {
  const { createAccountTransitions } =
    await import('../../src/features/account/account-transitions')
  const cache = new QueryClient(),
    drafts = storage(),
    boundary = createAccountBoundary(cache, drafts)
  let applied: string | null = null
  const transitions = createAccountTransitions(boundary, {
    applied: (id) => {
      applied = id
    },
    expired() {},
    broadcast() {},
  })
  transitions.apply('alice', 'alice-session')
  let finish!: (value: { error: null }) => void
  const request = new Promise<{ error: null }>((resolve) => {
    finish = resolve
  })
  const logout = transitions.signOut(
    () => request,
    async () => {},
  )
  expect(applied).toBeNull()
  transitions.apply('alice', 'alice-session')
  expect(applied).toBeNull()
  cache.setQueryData(['account', 'alice', 'late'], 'late private refill')
  drafts.setItem(draftKey('alice', 'reply'), 'late private draft')
  let resolveLate!: (value: string) => void
  const lateQuery = cache
    .fetchQuery({
      queryKey: ['account', 'alice', 'network'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve
        }),
    })
    .catch(() => undefined)
  finish({ error: null })
  await logout
  resolveLate('late private response after completed logout')
  await lateQuery
  expect(cache.getQueryData(['account', 'alice', 'network'])).toBeUndefined()
  expect(applied).toBeNull()
  expect(boundary.owner()).toBeNull()
  expect(cache.getQueryData(['account', 'alice', 'late'])).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
})

test('a current logout failure restores only its own session after clearing private refills', async () => {
  const { createAccountTransitions } =
    await import('../../src/features/account/account-transitions')
  const cache = new QueryClient(),
    drafts = storage(),
    boundary = createAccountBoundary(cache, drafts)
  let applied: string | null = null
  const transitions = createAccountTransitions(boundary, {
    applied: (id) => {
      applied = id
    },
    expired() {},
    broadcast() {},
  })
  transitions.apply('alice', 'alice-session')
  let fail!: (error: Error) => void
  const request = new Promise<{ error: null }>((_resolve, reject) => {
    fail = reject
  })
  const logout = transitions
    .signOut(
      () => request,
      async () => {},
    )
    .catch((error) => error)
  expect(applied).toBeNull()
  cache.setQueryData(['account', 'alice', 'late'], 'private refill')
  drafts.setItem(draftKey('alice', 'reply'), 'private refill')
  fail(new Error('network unavailable'))
  expect(await logout).toBeInstanceOf(Error)
  expect(applied).toBe('alice')
  expect(boundary.owner()).toBe('alice')
  expect(cache.getQueryData(['account', 'alice', 'late'])).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
})

test('guest_survives_account_delete_and_stale_delete_does_not_clear_new_owner', async () => {
  const { createAccountTransitions } =
    await import('../../src/features/account/account-transitions')
  const cache = new QueryClient(),
    drafts = storage(),
    boundary = createAccountBoundary(cache, drafts)
  let applied: string | null = null
  const transitions = createAccountTransitions(boundary, {
    applied: (id) => {
      applied = id
    },
    expired() {},
    broadcast() {},
  })
  transitions.apply('alice', 'a-session')
  cache.setQueryData(['account', 'alice', 'private'], 'a')
  drafts.setItem(draftKey('alice', 'reply'), 'a draft')
  drafts.setItem('threadly-library', 'guest')
  cache.setQueryData(['local-library'], ['guest'])
  transitions.deleted('alice')
  expect(applied).toBeNull()
  transitions.apply('alice', 'a-session')
  expect(applied).toBeNull()
  expect(cache.getQueryData(['account', 'alice', 'private'])).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
  transitions.apply('bob', 'b-session')
  cache.setQueryData(['account', 'bob', 'private'], 'b')
  drafts.setItem(draftKey('bob', 'reply'), 'b draft')
  transitions.deleted('alice')
  expect(applied).toBe('bob')
  expect(cache.getQueryData(['account', 'bob', 'private'])).toBe('b')
  expect(drafts.getItem(draftKey('bob', 'reply'))).toBe('b draft')
  expect(cache.getQueryData(['local-library'])).toEqual(['guest'])
  expect(drafts.getItem('threadly-library')).toBe('guest')
})
