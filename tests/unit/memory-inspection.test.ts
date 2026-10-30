import type { ReactElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { AccountProvider } from '../../src/features/account/auth-client'
import { CommentItem } from '../../src/features/discussion/CommentItem'
import { draftKey } from '../../src/features/account/auth-state'

// A shallow hook host exposes the real component's event handlers and the real
// AccountProvider's effects without introducing a DOM dependency. Requests,
// expiry events, owner guards, cache transitions and draft storage remain real.
const runtime = vi.hoisted(() => ({
  host: null as any,
  client: null as any,
  session: null as any,
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState(initial: unknown) {
    const host = runtime.host,
      index = host.cursor++
    if (!(index in host.cells))
      host.cells[index] = typeof initial === 'function' ? initial() : initial
    return [
      host.cells[index],
      (value: any) => {
        host.cells[index] =
          typeof value === 'function' ? value(host.cells[index]) : value
      },
    ]
  },
  useRef(initial: unknown) {
    const host = runtime.host,
      index = host.cursor++
    host.cells[index] ??= { current: initial }
    return host.cells[index]
  },
  useEffect(effect: () => void | (() => void)) {
    runtime.host.effects.push(effect)
  },
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => runtime.client,
}))
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => runtime.session,
    $store: {
      atoms: {
        session: {
          get: () => runtime.session,
          set: (next: any) => {
            runtime.session = { ...runtime.session, ...next }
          },
        },
      },
    },
  }),
}))

type Host = {
  cells: any[]
  cursor: number
  effects: (() => void | (() => void))[]
  cleanup: (() => void)[]
}
const host = (): Host => ({ cells: [], cursor: 0, effects: [], cleanup: [] })
function render<T>(target: Host, component: () => T): T {
  runtime.host = target
  target.cursor = 0
  target.effects = []
  return component()
}
function effects(target: Host) {
  target.cleanup.forEach((fn) => fn())
  target.cleanup = target.effects
    .map((fn) => fn())
    .filter((fn): fn is () => void => typeof fn === 'function')
}
function storage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
    clear: () => values.clear(),
  }
}
function session(owner: string) {
  return {
    data: {
      user: { id: owner, name: owner, emailVerified: true },
      session: { id: 'session-' + owner },
    },
    error: null,
    isPending: false,
    refetch: vi.fn(async () => {}),
  }
}
function inspectButton(element: any): any {
  if (!element || typeof element !== 'object') return undefined
  if (
    element.type === 'button' &&
    element.props.className.includes('discussion-memory-button')
  )
    return element
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = inspectButton(child)
    if (found) return found
  }
}
const comment = {
  id: 'comment',
  threadId: 'thread',
  postId: 'post',
  parentId: null,
  authorKind: 'ai' as const,
  authorId: 'persona',
  text: 'Private reply',
  sequence: 1,
  createdAt: '',
  turnId: null,
  passageIds: [],
  usedMemoryIds: ['30000000-0000-4000-8000-000000000001'],
}
let providerHost: Host, commentHost: Host, drafts: ReturnType<typeof storage>
let events: (string | undefined)[]
function provider() {
  return render(providerHost, () =>
    AccountProvider({ children: null }),
  ) as ReactElement<{ value: { user: { id: string } | null } }>
}
function setupInspection() {
  const props = {
    owner: 'alice',
    comment,
    name: 'Flint',
    parent: null,
    onReply() {},
    sourceText: '',
  }
  const element = render(commentHost, () => CommentItem(props))
  effects(commentHost)
  return inspectButton(element).props.onClick as () => Promise<void>
}
beforeEach(() => {
  runtime.client = new QueryClient()
  runtime.session = session('alice')
  providerHost = host()
  commentHost = host()
  drafts = storage()
  events = []
  const window = new EventTarget()
  window.addEventListener('threadly:session-expired', (event) => {
    events.push((event as CustomEvent).detail.owner)
  })
  vi.stubGlobal('window', window)
  vi.stubGlobal('sessionStorage', drafts)
  vi.stubGlobal('localStorage', storage())
  provider()
  effects(providerHost)
  expect(provider().props.value.user?.id).toBe('alice')
})
afterEach(() => {
  providerHost.cleanup.forEach((fn) => fn())
  commentHost.cleanup.forEach((fn) => fn())
  runtime.client.clear()
  vi.unstubAllGlobals()
})

test('inspection_401_expires_its_active_owner_hides_private_cache_and_preserves_draft', async () => {
  drafts.setItem(draftKey('alice', 'reply'), 'Unsent thought')
  runtime.client.setQueryData(
    ['account', 'alice', 'thread'],
    'Private reader content',
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    ),
  )
  await setupInspection()()
  expect(events).toEqual(['alice'])
  expect(provider().props.value.user).toBeNull()
  expect(
    runtime.client.getQueryData(['account', 'alice', 'thread']),
  ).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBe('Unsent thought')
})

test('obsolete_inspection_401_keeps_new_owner_and_unmount_aborts_old_request', async () => {
  let release!: (response: Response) => void, signal!: AbortSignal
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init) => {
      signal = init.signal
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }),
  )
  const pending = setupInspection()()
  // Mimic the existing owner-keyed reader unmount while a completed response is
  // already racing its abort; the old response must still identify Alice.
  commentHost.cleanup.forEach((fn) => fn())
  commentHost.cleanup = []
  expect(signal.aborted).toBe(true)
  runtime.session = session('bob')
  provider()
  effects(providerHost)
  expect(provider().props.value.user?.id).toBe('bob')
  drafts.setItem(draftKey('bob', 'reply'), 'Bob draft')
  runtime.client.setQueryData(
    ['account', 'bob', 'thread'],
    'Bob private reader',
  )
  release(Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }))
  await pending
  expect(events).toEqual(['alice'])
  expect(provider().props.value.user?.id).toBe('bob')
  expect(runtime.client.getQueryData(['account', 'bob', 'thread'])).toBe(
    'Bob private reader',
  )
  expect(drafts.getItem(draftKey('bob', 'reply'))).toBe('Bob draft')
})

test('confirmed_deletion_clears_actual_session_atom_cache_and_drafts_even_if_refresh_fails', async () => {
  const api = provider().props.value as any
  drafts.setItem(draftKey('alice', 'reply'), 'Private draft')
  drafts.setItem('threadly-library', 'Guest records')
  runtime.client.setQueryData(['account', 'alice', 'thread'], 'Private reader')
  runtime.session.refetch = vi.fn(async () => {
    throw new Error('offline')
  })
  api.deleted('alice')
  expect(runtime.session.data).toBeNull()
  expect(provider().props.value.user).toBeNull()
  expect(
    runtime.client.getQueryData(['account', 'alice', 'thread']),
  ).toBeUndefined()
  expect(drafts.getItem(draftKey('alice', 'reply'))).toBeNull()
  expect(drafts.getItem('threadly-library')).toBe('Guest records')
})
test('stale_confirmed_account_deletion_keeps_new_session_atom_and_private_cache', () => {
  const aliceApi = provider().props.value as any
  runtime.session = session('bob')
  provider()
  effects(providerHost)
  drafts.setItem(draftKey('bob', 'reply'), 'Bob draft')
  runtime.client.setQueryData(['account', 'bob', 'thread'], 'Bob private')
  aliceApi.deleted('alice')
  expect(runtime.session.data.user.id).toBe('bob')
  expect(provider().props.value.user?.id).toBe('bob')
  expect(drafts.getItem(draftKey('bob', 'reply'))).toBe('Bob draft')
  expect(runtime.client.getQueryData(['account', 'bob', 'thread'])).toBe(
    'Bob private',
  )
})
