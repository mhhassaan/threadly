import { afterEach, expect, test, vi } from 'vitest'
import { useThreadGeneration } from '../../src/features/generation/useThreadGeneration'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as (() => void)[],
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
const options = {
  owner: 'alice',
  sessionKey: 'session-a',
  pending: false,
  unavailable: false,
  onComplete: vi.fn(),
}
function render(patch = {}) {
  runtime.cursor = 0
  const result = useThreadGeneration({ ...options, ...patch })
  runtime.effects.splice(0).forEach((fn) => fn())
  return result
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  runtime.cells = []
  runtime.effects = []
})
test('actual hook refreshes exhausted quota after midnight UTC using GET only', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-09T23:59:59.000Z'))
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  const fetcher = vi.fn(async (_path: string, _init: RequestInit) =>
    Response.json({
      kind: 'account',
      limit: 10,
      used: Date.now() < Date.parse('2026-11-10') ? 10 : 0,
      reserved: 0,
      remaining: Date.now() < Date.parse('2026-11-10') ? 0 : 10,
      resetAt:
        Date.now() < Date.parse('2026-11-10')
          ? '2026-11-10T00:00:00.000Z'
          : '2026-11-11T00:00:00.000Z',
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  render()
  await vi.advanceTimersByTimeAsync(0)
  expect(render().quota?.remaining).toBe(0)
  await vi.advanceTimersByTimeAsync(1200)
  expect(render().quota?.remaining).toBe(10)
  expect(
    fetcher.mock.calls.every(
      ([p, i]) => p === '/api/generation/quota' && i.method === 'GET',
    ),
  ).toBe(true)
})
test('pending authentication performs no quota or guest bootstrap requests', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render({ pending: true })
  await Promise.resolve()
  expect(fetcher).not.toHaveBeenCalled()
})
