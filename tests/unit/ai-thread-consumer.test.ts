import { afterEach, expect, test, vi } from 'vitest'
import { Threadly } from '../../src/components/Threadly'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as { fn: () => void; deps: any[] }[],
  account: {
    user: null,
    pending: false,
    unavailable: false,
    expired: false,
    generationClaimPending: false,
    generationClaimError: '',
    sessionKey: 'guest',
  } as any,
  summarized: vi.fn(),
  opens: [] as any[],
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: any) {
    const i = runtime.cursor++
    if (!(i in runtime.cells))
      runtime.cells[i] = typeof initial === 'function' ? initial() : initial
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
  useEffect(fn: () => void, deps: any[] = []) {
    runtime.effects.push({ fn, deps })
  },
  useCallback: (fn: any) => fn,
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({
    mutateAsync: vi.fn(async () => ({
      text: 'Old extractor '.repeat(30),
      title: 'Old source',
      media: [],
    })),
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../../src/features/account/auth-client', () => ({
  useAccount: () => runtime.account,
  useAccountStatus: () => runtime.account,
}))
vi.mock('../../src/features/account/useCloudReader', () => ({
  useCloudReader: () => ({ record: null, query: {} }),
}))
vi.mock('../../src/features/reader/useAutomaticReadingProgress', () => ({
  useAutomaticReadingProgress() {},
}))
vi.mock('../../src/lib/summary', () => ({
  summarize: (...args: any[]) => {
    runtime.summarized(...args)
    return ['Old deterministic output']
  },
}))
function find(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, match)
    if (found) return found
  }
}
function render() {
  runtime.effects = []
  runtime.cursor = 0
  const view = Threadly({})
  return view.type(view.props)
}
const node = (id: string) => find(render(), (n) => n.props?.id === id)
const record = {
  id: 'record-server',
  title: 'Server AI thread',
  posts: ['Complete server thought'],
  sourceUrl: '',
  source: null,
  media: [],
  interactions: {},
}
function setup() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  }
  vi.stubGlobal('sessionStorage', storage)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('location', {
    href: 'http://localhost:4198/',
    origin: 'http://localhost:4198',
  })
  vi.stubGlobal('window', {
    open: vi.fn(() => {
      const win = {
        closed: false,
        close: vi.fn(),
        postMessage: vi.fn(),
        sessionStorage: storage,
        location: { replace: vi.fn() },
      }
      runtime.opens.push(win)
      return win
    }),
    dispatchEvent: vi.fn(),
  })
  vi.stubGlobal('document', { getElementById: () => null })
  return vi.fn(async (path: string, init: RequestInit) =>
    Response.json(
      path.endsWith('/identity') || path.endsWith('/quota')
        ? { kind: 'guest', limit: 2, remaining: 2 }
        : path === '/api/generation'
          ? { id: 'job-server', status: 'reserved' }
          : { id: 'job-server', status: 'complete', record },
    ),
  )
}
afterEach(() => {
  runtime.cells = []
  runtime.opens = []
  runtime.account = {
    user: null,
    pending: false,
    unavailable: false,
    expired: false,
    generationClaimPending: false,
    generationClaimError: '',
    sessionKey: 'guest',
  }
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
test.each(['text', 'file', 'url'])(
  'actual %s creation event uses generator and never summarize',
  async (mode) => {
    const fetcher = setup()
    vi.stubGlobal('fetch', fetcher)
    node('sourceText').props.onChange({
      target: { value: 'Public synthetic source words '.repeat(40) },
    })
    if (mode !== 'text') node(mode + 'Tab').props.onClick()
    if (mode === 'url')
      node('articleUrl').props.onChange({
        target: { value: 'https://example.com/story' },
      })
    node('generate').props.onClick()
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([p, i]) => p === '/api/generation' && i.method === 'POST',
        ),
      ).toBe(true),
    )
    await vi.waitFor(() =>
      expect(runtime.opens[0]?.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ record }),
        'http://localhost:4198',
      ),
    )
    expect(runtime.summarized).not.toHaveBeenCalled()
    const body = JSON.parse(
      fetcher.mock.calls.find(([p]) => p === '/api/generation')![1]
        .body as string,
    )
    expect(body.mode).toBe(mode)
  },
)
test.each([
  { pending: true },
  { unavailable: true },
  { expired: true },
  { generationClaimPending: true },
])(
  'unresolved identity %j cannot bootstrap guest generation',
  async (state) => {
    const fetcher = setup()
    vi.stubGlobal('fetch', fetcher)
    Object.assign(runtime.account, state)
    node('sourceText').props.onChange({
      target: { value: 'Public synthetic words '.repeat(40) },
    })
    expect(node('generate').props.disabled).toBe(true)
    node('generate').props.onClick()
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  },
)

test('account save lost response recovers the stable server record through Retry account save, without regeneration/opening', async () => {
  const base = setup()
  runtime.account.user = { id: 'alice', verified: true }
  runtime.account.sessionKey = 'alice-session'
  let saves = 0
  const snapshot = {
    thread: { id: record.id, ownerId: 'alice', record, posts: [] },
    comments: [],
    readPostId: null,
    readAt: null,
  }
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/library') {
      saves++
      expect(JSON.parse(init.body as string).record.id).toBe(record.id)
      if (saves === 1) throw Error('response lost')
      return Response.json({ code: 'CONFLICT' }, { status: 409 })
    }
    if (path === '/api/threads/' + record.id) return Response.json(snapshot)
    return base(path, init)
  })
  vi.stubGlobal('fetch', fetcher)
  node('sourceText').props.onChange({
    target: { value: 'Public source '.repeat(40) },
  })
  node('generate').props.onClick()
  await vi.waitFor(() => expect(node('reopenReader')).toBeTruthy())
  expect(node('reopenReader').props.children).toBe('Retry account save')
  node('reopenReader').props.onClick()
  await vi.waitFor(() =>
    expect(runtime.opens.at(-1)?.location.replace).not.toHaveBeenCalled(),
  )
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.some(([p]) => p === '/api/threads/' + record.id),
    ).toBe(true),
  )
  expect(
    fetcher.mock.calls.filter(([p]) => p === '/api/generation'),
  ).toHaveLength(1)
  expect(
    sessionStorage.getItem('threadly-account:alice:draft:generated'),
  ).toBeNull()
})
test('account switch hides private source/result on the first render, before effects', () => {
  setup()
  runtime.account.user = { id: 'alice', verified: true }
  runtime.account.sessionKey = 'alice-session'
  node('sourceText').props.onChange({
    target: { value: 'Alice private source '.repeat(40) },
  })
  runtime.account.user = { id: 'bob', verified: true }
  runtime.account.sessionKey = 'bob-session'
  expect(node('sourceText').props.value).toBe('')
  expect(node('resultNotice')).toBeUndefined()
})

test('guest source survives verified sign-in/claim for an explicit fresh account retry', () => {
  setup()
  const source = 'Public guest source '.repeat(40)
  node('sourceText').props.onChange({ target: { value: source } })
  runtime.account.user = { id: 'alice', verified: true }
  runtime.account.sessionKey = 'alice-session'
  runtime.account.generationClaimPending = true
  expect(node('generate').props.disabled).toBe(true)
  runtime.account.generationClaimPending = false
  expect(node('sourceText').props.value).toBe(source)
})
test('failed generation keeps source, closes preparing window, and opens no partial result', async () => {
  const base = setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (p: string, i: RequestInit) =>
      p.endsWith('/job-server') && i.method === 'POST'
        ? Response.json({
            id: 'job-server',
            status: 'failed',
            errorCode: 'PROVIDER_ERROR',
          })
        : base(p, i),
    ),
  )
  const source = 'Public source '.repeat(40)
  node('sourceText').props.onChange({ target: { value: source } })
  node('generate').props.onClick()
  await vi.waitFor(() => expect(runtime.opens[0].close).toHaveBeenCalled())
  expect(node('sourceText').props.value).toBe(source)
  expect(runtime.opens[0].postMessage).not.toHaveBeenCalled()
  expect(node('resultNotice')).toBeUndefined()
})

test.each([{ pending: true }, { unavailable: true }, { expired: true }])(
  'private reader title is cleared when identity is blocked %j',
  (blocked) => {
    setup()
    runtime.account.user = { id: 'alice', verified: true }
    Object.assign(runtime.account, blocked)
    const remove = vi.fn()
    vi.stubGlobal('document', {
      title: 'Alice private title',
      documentElement: { classList: { remove } },
    })
    runtime.effects = []
    Threadly({ threadId: 'private-thread' })
    runtime.effects.forEach(({ fn }) => fn())
    expect(document.title).toBe('Your private thread — Threadly')
    expect(remove).toHaveBeenCalledWith('reader-page')
  },
)

test('after an account switch, transient auth checks keep the new owner source', async () => {
  const base = setup()
  runtime.account.user = { id: 'alice', verified: true }
  runtime.account.sessionKey = 'alice-session'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (p: string, i: RequestInit) =>
      p === '/api/library'
        ? Response.json({ thread: { id: record.id, record, posts: [] } })
        : base(p, i),
    ),
  )
  node('sourceText').props.onChange({
    target: { value: 'Alice source '.repeat(40) },
  })
  node('generate').props.onClick()
  await vi.waitFor(() => expect(node('resultNotice')).toBeTruthy())
  const flushOwner = (owner: string, blocked: boolean) => {
    const effect = runtime.effects.find(
      ({ deps }) =>
        deps.length === 2 && deps[0] === owner && deps[1] === blocked,
    )
    expect(effect).toBeTruthy()
    effect!.fn()
  }
  runtime.account.user = { id: 'bob', verified: true }
  runtime.account.sessionKey = 'bob-session'
  node('sourceText')
  flushOwner('bob', false)
  const source = 'Bob source '.repeat(40)
  node('sourceText').props.onChange({ target: { value: source } })
  runtime.account.pending = true
  node('sourceText')
  flushOwner('bob', true)
  runtime.account.pending = false
  node('sourceText')
  flushOwner('bob', false)
  expect(node('sourceText').props.value).toBe(source)
})
