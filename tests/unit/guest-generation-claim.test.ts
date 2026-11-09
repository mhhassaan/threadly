import { afterEach, expect, test, vi } from 'vitest'
import { AccountProvider } from '../../src/features/account/auth-client'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as any[],
  session: {} as any,
}))
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({ useSession: () => runtime.session }),
}))
vi.mock('better-auth/client/plugins', () => ({
  inferAdditionalFields: () => ({}),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: any) {
    const i = runtime.cursor++
    if (!(i in runtime.cells)) runtime.cells[i] = initial
    return [
      runtime.cells[i],
      (next: any) => {
        runtime.cells[i] =
          typeof next === 'function' ? next(runtime.cells[i]) : next
      },
    ]
  },
  useRef(initial: any) {
    return (runtime.cells[runtime.cursor++] ??= { current: initial })
  },
  useEffect(fn: any, deps: any[]) {
    const i = runtime.cursor++,
      old = runtime.cells[i]
    if (!old || deps.some((value, j) => value !== old[j])) {
      runtime.cells[i] = deps
      runtime.effects.push(fn)
    }
  },
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }))
vi.mock('../../src/features/account/auth-state', () => ({
  createAccountBoundary: () => ({}),
  resolveSessionUser: (user: any) => user ?? null,
  clearAccountCache() {},
  draftKey: () => '',
}))
vi.mock('../../src/features/account/account-transitions', () => ({
  createAccountTransitions: (_: any, hooks: any) => ({
    apply: (id: string) => hooks.applied(id),
    deleted() {},
    signOut() {},
  }),
}))
function render() {
  runtime.cursor = 0
  const tree = AccountProvider({ children: null })
  runtime.effects.splice(0).forEach((fn) => fn())
  return tree.props.value as any
}
function setup(used: number) {
  runtime.session = {
    data: {
      user: { id: 'alice', verified: true },
      session: { id: 'session-a' },
    },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }
  vi.stubGlobal('sessionStorage', {})
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  })
  const fetcher = vi.fn(async (_path: string, _init: RequestInit) =>
    Response.json({
      kind: 'account',
      limit: 10,
      used,
      reserved: 0,
      remaining: 10 - used,
      resetAt: '2026-11-10T00:00:00.000Z',
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => {
  runtime.cells = []
  runtime.effects = []
  vi.unstubAllGlobals()
})
test.each([1, 2])(
  'first verified sign-in claims %i guest uses once before usable account allowance',
  async (used) => {
    const fetcher = setup(used)
    expect(render().generationQuota).toBeNull()
    expect(render().generationClaimPending).toBe(true)
    await vi.waitFor(() =>
      expect(render().generationQuota?.remaining).toBe(10 - used),
    )
    render()
    render()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/generation/claim')
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      body: '{}',
    })
  },
)
test('pending and unavailable authentication never claim or bootstrap a guest', () => {
  const fetcher = setup(0)
  runtime.session.isPending = true
  render()
  render()
  expect(fetcher).not.toHaveBeenCalled()
  runtime.session.isPending = false
  runtime.session.error = Error('offline')
  render()
  render()
  expect(fetcher).not.toHaveBeenCalled()
})
test('old claim cannot expose another account quota; changed session requires its own claim', async () => {
  const fetcher = setup(2)
  render()
  render()
  await vi.waitFor(() => expect(render().generationQuota?.remaining).toBe(8))
  runtime.session.data = {
    user: { id: 'bob', verified: true },
    session: { id: 'session-b' },
  }
  expect(render().generationQuota).toBeNull()
  expect(render().generationClaimPending).toBe(true)
  await vi.waitFor(() => expect(render().generationQuota?.remaining).toBe(8))
  expect(fetcher).toHaveBeenCalledTimes(2)
})
