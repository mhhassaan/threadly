import { afterEach, expect, test, vi } from 'vitest'
import { createThreadGeneration } from '../../src/features/generation/useThreadGeneration'
import { processingNoticeVersion } from '../../src/lib/ai-processing'
const record = {
  id: 'record-server',
  title: 'Thread',
  posts: ['A complete thought.'],
  sourceUrl: '',
  source: null,
  media: [],
  interactions: {},
  sourceText: 'Source',
}
const input = {
  mode: 'text' as const,
  source: 'Thirty source words '.repeat(30),
  depth: 'balanced' as const,
  length: 'auto' as const,
}
const quota = {
  kind: 'guest',
  limit: 2,
  used: 0,
  reserved: 0,
  remaining: 2,
  resetAt: null,
}
const reserved = { id: 'job-server', status: 'reserved', phase: 'preparing' }
function setup(
  handler?: (path: string, init: RequestInit) => Promise<Response>,
) {
  const calls: [string, RequestInit][] = []
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    calls.push([path, init])
    if (handler) return handler(path, init)
    return Response.json(
      path.endsWith('/identity') || path.endsWith('/quota')
        ? quota
        : path === '/api/generation'
          ? reserved
          : { ...reserved, status: 'complete', record },
    )
  })
  vi.stubGlobal('fetch', fetcher)
  let current = true
  const complete = vi.fn()
  const values = new Map<string, string>()
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  }
  const controller = createThreadGeneration({
    owner: '',
    key: 'guest',
    isCurrent: () => current,
    onComplete: complete,
    storage,
  })
  return {
    controller,
    calls,
    complete,
    values,
    leave: () => {
      current = false
    },
  }
}
afterEach(() => vi.unstubAllGlobals())
test.each(['text', 'file', 'url'] as const)(
  'explicit %s create awaits identity, admission and execution; stable server record only',
  async (mode) => {
    const x = setup()
    await x.controller.start({ ...input, mode })
    expect(x.calls.map(([p, i]) => [p, i.method])).toEqual([
      ['/api/generation/identity', 'POST'],
      ['/api/generation', 'POST'],
      ['/api/generation/job-server', 'POST'],
      ['/api/generation/quota', 'GET'],
    ])
    expect(JSON.parse(x.calls[0][1].body as string)).toEqual({
      noticeVersion: processingNoticeVersion,
    })
    expect(JSON.parse(x.calls[1][1].body as string)).toMatchObject({
      ...input,
      mode,
      requestId: expect.any(String),
    })
    expect(JSON.parse(x.calls[2][1].body as string)).toEqual({})
    expect(x.complete).toHaveBeenCalledWith(record, true)
  },
)
test('busy duplicate clicks create exactly one operation', async () => {
  let release!: () => void
  const blocked = new Promise<void>((r) => {
    release = r
  })
  const x = setup(async (p) => {
    if (p.endsWith('/identity')) {
      await blocked
      return Response.json(quota)
    }
    return Response.json(
      p === '/api/generation'
        ? reserved
        : { ...reserved, status: 'complete', record },
    )
  })
  const first = x.controller.start(input)
  await x.controller.start(input)
  release()
  await first
  expect(x.calls.filter(([p]) => p === '/api/generation')).toHaveLength(1)
})
test.each(['cancel', 'owner'] as const)(
  'late admission after %s is deleted and never executed/published',
  async (reason) => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const x = setup(async (p, i) => {
      if (p === '/api/generation') {
        await blocked
        return Response.json(reserved)
      }
      return Response.json(
        p.endsWith('/identity')
          ? quota
          : {
              ...reserved,
              status: i.method === 'DELETE' ? 'cancelled' : 'reserved',
            },
      )
    })
    const pending = x.controller.start(input)
    await vi.waitFor(() =>
      expect(x.calls.some(([p]) => p === '/api/generation')).toBe(true),
    )
    if (reason === 'cancel') x.controller.cancel()
    else x.leave()
    release()
    await pending
    expect(
      x.calls.filter(
        ([p, i]) => p.endsWith('/job-server') && i.method === 'POST',
      ),
    ).toHaveLength(0)
    expect(
      x.calls.some(
        ([p, i]) => p.endsWith('/job-server') && i.method === 'DELETE',
      ),
    ).toBe(true)
    expect(x.complete).not.toHaveBeenCalled()
  },
)
test('lost admission response recovers by requestId GET; status never executes reserved work', async () => {
  const x = setup(async (p) => {
    if (p.endsWith('/identity')) return Response.json(quota)
    if (p === '/api/generation') throw Error('lost')
    return Response.json(reserved)
  })
  await x.controller.start(input)
  expect(x.controller.snapshot().phase).toBe('recovering')
  await x.controller.retryStatus()
  expect(
    x.calls.some(
      ([p, i]) =>
        p.startsWith('/api/generation?requestId=') && i.method === 'GET',
    ),
  ).toBe(true)
  expect(x.calls.filter(([, i]) => i.method === 'POST')).toHaveLength(2)
  expect(x.complete).not.toHaveBeenCalled()
})
test('lost execution response reads same job and recovered result has no fresh opening intent', async () => {
  const x = setup(async (p, i) => {
    if (p.endsWith('/identity') || p.endsWith('/quota'))
      return Response.json(quota)
    if (p === '/api/generation') return Response.json(reserved)
    if (i.method === 'POST') throw Error('offline')
    return Response.json({ ...reserved, status: 'complete', record })
  })
  await x.controller.start(input)
  await x.controller.retryStatus()
  await x.controller.retryStatus()
  expect(x.complete).toHaveBeenCalledTimes(1)
  expect(x.complete).toHaveBeenCalledWith(record, false)
  expect(
    x.calls.filter(
      ([p, i]) => p.endsWith('/job-server') && i.method === 'POST',
    ),
  ).toHaveLength(1)
})
test('terminal failure explicit retry uses a new requestId', async () => {
  const x = setup(async (p) =>
    Response.json(
      p.endsWith('/identity') || p.endsWith('/quota')
        ? quota
        : p === '/api/generation'
          ? reserved
          : { ...reserved, status: 'failed', errorCode: 'PROVIDER_ERROR' },
    ),
  )
  await x.controller.start(input)
  await x.controller.start(input)
  const ids = x.calls
    .filter(([p]) => p === '/api/generation')
    .map(([, i]) => JSON.parse(i.body as string).requestId)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
  expect(x.complete).not.toHaveBeenCalled()
})

test('cancelled admission cleanup failure retains recovery marker and blocks a new paid request until DELETE succeeds', async () => {
  let canDelete = false
  const x = setup(async (p, i) => {
    if (p.endsWith('/identity') || p.endsWith('/quota'))
      return Response.json(quota)
    if (p === '/api/generation') return Response.json(reserved)
    if (i.method === 'POST') throw Error('offline')
    if (i.method === 'DELETE' && !canDelete) throw Error('offline')
    return Response.json({ ...reserved, status: 'cancelled' })
  })
  await x.controller.start(input)
  x.controller.cancel()
  await x.controller.start(input)
  expect(x.calls.filter(([p]) => p === '/api/generation')).toHaveLength(1)
  expect(x.controller.snapshot().phase).toBe('recovering')
  canDelete = true
  await x.controller.retryStatus()
  expect(x.controller.snapshot().phase).toBe('cancelled')
})
test('account daily reset is read from server quota without creating an identity or job', async () => {
  let tomorrow = false
  const x = setup(async () =>
    Response.json({
      kind: 'account',
      limit: 10,
      used: tomorrow ? 0 : 10,
      reserved: 0,
      remaining: tomorrow ? 10 : 0,
      resetAt: tomorrow ? '2026-11-11T00:00:00Z' : '2026-11-10T00:00:00Z',
    }),
  )
  await x.controller.refreshQuota()
  expect(x.controller.snapshot().quota?.remaining).toBe(0)
  tomorrow = true
  await x.controller.refreshQuota()
  expect(x.controller.snapshot().quota?.remaining).toBe(10)
  expect(
    x.calls.every(
      ([p, i]) => p === '/api/generation/quota' && i.method === 'GET',
    ),
  ).toBe(true)
})

test('cancelled admission with authoritative no-job 404 clears its marker and permits a fresh Create', async () => {
  let admissions = 0
  const x = setup(async (p, i) => {
    if (p.endsWith('/identity') || p.endsWith('/quota'))
      return Response.json(quota)
    if (p === '/api/generation') {
      if (++admissions === 1) throw Error('admission did not arrive')
      return Response.json(reserved)
    }
    if (p.includes('?requestId='))
      return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
    return Response.json({ ...reserved, status: 'complete', record })
  })
  await x.controller.start(input)
  x.controller.cancel()
  await x.controller.retryStatus()
  expect(x.values.size).toBe(0)
  await x.controller.start(input)
  expect(admissions).toBe(2)
  expect(x.complete).toHaveBeenCalledOnce()
})

test('persisted cancelled no-job operation clears after owned 404 on reload', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (p: string) =>
      p.endsWith('/quota')
        ? Response.json(quota)
        : Response.json({ code: 'NOT_FOUND' }, { status: 404 }),
    ),
  )
  const values = new Map([
    [
      'threadly-generation:guest',
      JSON.stringify({ requestId: 'absent-request', cancelled: true }),
    ],
  ])
  const controller = createThreadGeneration({
    owner: '',
    key: 'guest',
    isCurrent: () => true,
    onComplete: vi.fn(),
    storage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        values.set(k, v)
      },
      removeItem: (k) => {
        values.delete(k)
      },
    },
  })
  await controller.retryStatus()
  expect(values.size).toBe(0)
  expect(controller.snapshot().phase).toBe('cancelled')
})

test.each(['offline', 'server'] as const)(
  'cancelled no-job cleanup keeps marker on %s uncertainty',
  async (failure) => {
    const x = setup(async (p) => {
      if (p.endsWith('/identity') || p.endsWith('/quota'))
        return Response.json(quota)
      if (p === '/api/generation' || failure === 'offline')
        throw Error('offline')
      return Response.json({ code: 'UNAVAILABLE' }, { status: 503 })
    })
    await x.controller.start(input)
    x.controller.cancel()
    await x.controller.retryStatus()
    expect(x.values.size).toBe(1)
    await x.controller.start(input)
    expect(x.calls.filter(([p]) => p === '/api/generation')).toHaveLength(1)
  },
)

test('cancel before late admission cannot clear its marker on an early 404 or admit a competing Create', async () => {
  let release!: () => void
  const wait = new Promise<void>((r) => {
    release = r
  })
  let admitted = false,
    admissions = 0
  const x = setup(async (p, i) => {
    if (p.endsWith('/identity') || p.endsWith('/quota'))
      return Response.json(quota)
    if (p === '/api/generation') {
      admissions++
      await wait
      admitted = true
      return Response.json(reserved)
    }
    if (p.includes('?requestId='))
      return admitted
        ? Response.json(reserved)
        : Response.json({ code: 'NOT_FOUND' }, { status: 404 })
    return Response.json({
      ...reserved,
      status: i.method === 'DELETE' ? 'cancelled' : 'complete',
      record,
    })
  })
  const first = x.controller.start(input)
  await vi.waitFor(() => expect(admissions).toBe(1))
  x.controller.cancel()
  await Promise.resolve()
  await x.controller.start(input)
  expect(x.values.size).toBe(1)
  expect(admissions).toBe(1)
  release()
  await first
  expect(
    x.calls.filter(
      ([p, i]) => p.endsWith('/job-server') && i.method === 'POST',
    ),
  ).toHaveLength(0)
  expect(
    x.calls.some(
      ([p, i]) => p.endsWith('/job-server') && i.method === 'DELETE',
    ),
  ).toBe(true)
  expect(x.values.size).toBe(0)
  await x.controller.start(input)
  expect(admissions).toBe(2)
  expect(x.complete).toHaveBeenCalledOnce()
})

test('cancelled in-flight admission clears only after it settles absent, then permits fresh creation', async () => {
  let rejectAdmission!: (error: Error) => void
  const pending = new Promise<Response>((_, reject) => {
    rejectAdmission = reject
  })
  let admissions = 0
  const x = setup(async (p, i) => {
    if (p.endsWith('/identity') || p.endsWith('/quota'))
      return Response.json(quota)
    if (p === '/api/generation') {
      if (++admissions === 1) return pending
      return Response.json(reserved)
    }
    if (p.includes('?requestId='))
      return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
    return Response.json({
      ...reserved,
      status: i.method === 'DELETE' ? 'cancelled' : 'complete',
      record,
    })
  })
  const first = x.controller.start(input)
  await vi.waitFor(() => expect(admissions).toBe(1))
  x.controller.cancel()
  await x.controller.start(input)
  expect(x.values.size).toBe(1)
  expect(x.calls.some(([p]) => p.includes('?requestId='))).toBe(false)
  rejectAdmission(Error('did not arrive'))
  await first
  expect(x.values.size).toBe(0)
  expect(x.controller.snapshot().phase).toBe('cancelled')
  await x.controller.start(input)
  expect(admissions).toBe(2)
  expect(x.complete).toHaveBeenCalledOnce()
})
