import { ApiError } from '../../src/lib/account-thread'
import { afterEach, expect, test, vi } from 'vitest'
import { useAutomaticReadingProgress } from '../../src/features/reader/useAutomaticReadingProgress'
import { saveReadingProgress } from '../../src/features/account/library'
import { privateDeletionEvent } from '../../src/features/account/private-drafts'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as any[],
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef(initial: any) {
    return (runtime.cells[runtime.cursor++] ??= { current: initial })
  },
  useEffect(fn: any, deps: any[]) {
    const i = runtime.cursor++,
      prior = runtime.cells[i]
    if (!prior || deps.some((value, j) => !Object.is(value, prior.deps[j]))) {
      runtime.effects.push(() => {
        prior?.cleanup?.()
        runtime.cells[i] = { deps, cleanup: fn() }
      })
    }
  },
}))
vi.mock('../../src/features/account/library', () => ({
  saveReadingProgress: vi.fn(),
}))
let observers: FakeObserver[] = []
class FakeObserver {
  targets: any[] = []
  disconnected = false
  constructor(
    public callback: any,
    public options: any,
  ) {
    observers.push(this)
  }
  observe(el: any) {
    this.targets.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
  emit(id: string, pixels = 200, height = 300) {
    const target = this.targets.find((el) => el.dataset.postId === id)
    this.callback([
      {
        target,
        isIntersecting: pixels > 0,
        intersectionRect: { height: pixels, width: 500 },
        boundingClientRect: { height },
        rootBounds: { height: 800 },
      },
    ])
  }
}
let doc: EventTarget & { visibilityState: string },
  win: EventTarget & { innerHeight: number }
let input: any, container: any, onSaved: any
const posts = [
  { id: 'p1', position: 0 },
  { id: 'p2', position: 1 },
  { id: 'p3', position: 2 },
]
function setup() {
  vi.useFakeTimers()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  win = Object.assign(new EventTarget(), { innerHeight: 800 })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  const elements = posts.map((p) => ({
    dataset: { postId: p.id },
    getBoundingClientRect: () => ({ height: p.id === 'p3' ? 2000 : 300 }),
  }))
  container = {
    querySelectorAll: vi.fn(() => elements),
    contains: (el: any) => elements.includes(el),
  }
  onSaved = vi.fn()
  input = {
    owner: 'alice',
    threadId: 'thread',
    posts,
    container,
    enabled: true,
    onSaved,
  }
  vi.mocked(saveReadingProgress).mockImplementation(
    async (_owner, _thread, postId) => ({ postId, readAt: 'now' }),
  )
}
function render(patch = {}) {
  input = { ...input, ...patch }
  runtime.cursor = 0
  useAutomaticReadingProgress(input)
  runtime.effects.splice(0).forEach((fn) => fn())
}
async function time(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}
function hidden(value: boolean) {
  doc.visibilityState = value ? 'hidden' : 'visible'
  doc.dispatchEvent(new Event('visibilitychange'))
}
function deletion(owner = 'alice') {
  const e = new Event(privateDeletionEvent)
  Object.assign(e, { detail: { owner, threadId: 'thread' } })
  win.dispatchEvent(e)
}
function unmount() {
  runtime.cells.forEach((cell) => cell?.cleanup?.())
}
afterEach(() => {
  unmount()
  runtime.cells = []
  runtime.effects = []
  observers = []
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
test('dwell_and_debounce_furthest_visible_in_actual_scoped_observer', async () => {
  setup()
  render()
  const observer = observers.at(-1)!
  expect(observer.targets).toHaveLength(3)
  observer.emit('p1', 149)
  await time(1500)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  observer.emit('p1')
  await time(499)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  observer.emit('p1', 0)
  await time(1000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  observer.emit('p1')
  await time(500)
  await time(400)
  observer.emit('p2')
  await time(500)
  await time(999)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  await time(1)
  expect(saveReadingProgress).toHaveBeenCalledExactlyOnceWith(
    'alice',
    'thread',
    'p2',
    expect.any(AbortSignal),
  )
  expect(onSaved).toHaveBeenCalledWith({ postId: 'p2', readAt: 'now' })
  observer.emit('p1')
  observer.emit('p2')
  await time(3000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
  // A post taller than the viewport must be reachable at half the viewport.
  observer.emit('p3', 399, 2000)
  await time(2000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
  observer.emit('p3', 400, 2000)
  await time(1500)
  expect(saveReadingProgress).toHaveBeenLastCalledWith(
    'alice',
    'thread',
    'p3',
    expect.any(AbortSignal),
  )
})
test('no_traffic_for_guest_hidden_or_unchanged_revisit', async () => {
  setup()
  render({ owner: '' })
  expect(observers).toHaveLength(0)
  render({ owner: 'alice', readPostId: 'p2' })
  let observer = observers.at(-1)!
  observer.emit('p1')
  observer.emit('p2')
  await time(3000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  observer.emit('p3', 400, 2000)
  await time(500)
  hidden(true)
  await time(3000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  hidden(false)
  observer = observers.at(-1)!
  observer.emit('p3', 400, 2000)
  await time(1500)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
  unmount()
  await time(3000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
})
test('slow_old_response_not_overwrite_newer_progress', async () => {
  setup()
  const resolvers: ((value: any) => void)[] = []
  vi.mocked(saveReadingProgress).mockImplementation(
    () => new Promise((resolve) => resolvers.push(resolve)),
  )
  render()
  const observer = observers.at(-1)!
  observer.emit('p1')
  await time(1500)
  observer.emit('p2')
  await time(1500)
  const oldSignal = vi.mocked(saveReadingProgress).mock.calls[0][3]!
  expect(oldSignal.aborted).toBe(true)
  resolvers[1]({ postId: 'p2', readAt: 'new' })
  await time(0)
  resolvers[0]({ postId: 'p1', readAt: 'old' })
  await time(0)
  expect(onSaved).toHaveBeenCalledExactlyOnceWith({
    postId: 'p2',
    readAt: 'new',
  })
})
test('owner_switch_or_delete_cancels_pending_and_late_responses', async () => {
  setup()
  render()
  observers.at(-1)!.emit('p1')
  await time(500)
  render({ owner: 'bob' })
  await time(2000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  render({ owner: 'alice' })
  observers.at(-1)!.emit('p2')
  await time(500)
  deletion('bob')
  await time(1000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
  let resolve!: (value: any) => void
  vi.mocked(saveReadingProgress).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  observers.at(-1)!.emit('p3', 400, 2000)
  await time(1500)
  const signal = vi.mocked(saveReadingProgress).mock.calls.at(-1)![3]!
  deletion()
  expect(signal.aborted).toBe(true)
  resolve({ postId: 'p3', readAt: 'late' })
  await time(0)
  expect(onSaved).toHaveBeenCalledTimes(1)
  observers.at(-1)!.emit('p3', 400, 2000)
  await time(2000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(2)
})
test('view_rebind_unmount_and_disabled_never_flush_or_call_content_save_or_generate', async () => {
  setup()
  const contentSave = vi.fn(),
    generate = vi.fn()
  render({ contentSave, generate })
  const old = observers.at(-1)!
  old.emit('p1')
  await time(500)
  render({ viewKey: 'focused:p2' })
  expect(old.disconnected).toBe(true)
  await time(1000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  old.emit('p3', 400, 2000)
  await time(1500)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  observers.at(-1)!.emit('p2')
  await time(500)
  render({ enabled: false })
  await time(1000)
  expect(saveReadingProgress).not.toHaveBeenCalled()
  expect(contentSave).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled()
})

test('hidden_and_unmount_abort_dispatched_request_and_ignore_late_result', async () => {
  setup()
  const resolvers: ((value: any) => void)[] = []
  vi.mocked(saveReadingProgress).mockImplementation(
    () => new Promise((resolve) => resolvers.push(resolve)),
  )
  render()
  observers.at(-1)!.emit('p1')
  await time(1500)
  const first = vi.mocked(saveReadingProgress).mock.calls[0][3]!
  hidden(true)
  expect(first.aborted).toBe(true)
  resolvers[0]({ postId: 'p1', readAt: 'late' })
  await time(0)
  expect(onSaved).not.toHaveBeenCalled()
  hidden(false)
  observers.at(-1)!.emit('p2')
  await time(1500)
  const second = vi.mocked(saveReadingProgress).mock.calls[1][3]!
  unmount()
  expect(second.aborted).toBe(true)
  resolvers[1]({ postId: 'p2', readAt: 'late' })
  await time(0)
  expect(onSaved).not.toHaveBeenCalled()
})
test('source_targets_scoped_and_resized_layout_rebinds_reachable_threshold', async () => {
  setup()
  const original = container.querySelectorAll()
  const extra = {
    dataset: { postId: 'comment' },
    getBoundingClientRect: () => ({ height: 100 }),
  }
  container.querySelectorAll.mockReturnValue([...original, extra])
  let resize!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  render()
  expect(observers.at(-1)!.targets).toEqual(original)
  expect(observers.at(-1)!.options.threshold).toContain(0.2)
  const old = observers.at(-1)!
  original[2].getBoundingClientRect = () => ({ height: 4000 })
  resize()
  expect(old.disconnected).toBe(true)
  expect(observers.at(-1)!.options.threshold).toContain(0.1)
  observers.at(-1)!.emit('p3', 400, 4000)
  await time(1500)
  expect(saveReadingProgress).toHaveBeenLastCalledWith(
    'alice',
    'thread',
    'p3',
    expect.any(AbortSignal),
  )
  unmount()
  expect(disconnect).toHaveBeenCalled()
})

test('terminal404_stops_observation_and_offline_failure_is_not_retried', async () => {
  setup()
  vi.mocked(saveReadingProgress).mockRejectedValueOnce(
    new ApiError(0, 'OFFLINE', 'Offline'),
  )
  render()
  const observer = observers.at(-1)!
  observer.emit('p1')
  await time(1500)
  observer.emit('p1', 0)
  observer.emit('p1')
  await time(4000)
  expect(saveReadingProgress).toHaveBeenCalledTimes(1)
  vi.mocked(saveReadingProgress).mockRejectedValueOnce(
    new ApiError(404, 'NOT_FOUND', 'Deleted'),
  )
  observer.emit('p2')
  await time(1500)
  expect(observer.disconnected).toBe(true)
  observer.emit('p3', 400, 2000)
  await time(1500)
  expect(saveReadingProgress).toHaveBeenCalledTimes(2)
  expect(onSaved).not.toHaveBeenCalled()
})
test('newer_snapshot_read_marker_fences_a_slow_current_response', async () => {
  setup()
  let resolve!: (value: any) => void
  vi.mocked(saveReadingProgress).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  render()
  observers.at(-1)!.emit('p1')
  await time(1500)
  render({ readPostId: 'p3' })
  resolve({ postId: 'p1', readAt: 'old' })
  await time(0)
  expect(onSaved).not.toHaveBeenCalled()
})
