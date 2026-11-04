import { afterEach, expect, test, vi } from 'vitest'
import { AutomaticDiscussion } from '../../src/features/discussion/AutomaticDiscussion'
import { openingIntentKey } from '../../src/features/discussion/opening-intent'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as any[],
  discussion: {} as any,
  snapshot: undefined as any,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useContext: () => runtime.discussion,
  useRef(initial: any) {
    return (runtime.cells[runtime.cursor++] ??= { current: initial })
  },
  useEffect(fn: any) {
    runtime.effects.push(fn)
  },
}))
vi.mock('../../src/features/account/library', () => ({
  useCloudThread: () => ({ data: runtime.snapshot }),
}))
function render() {
  runtime.cursor = 0
  const result = AutomaticDiscussion({ threadId: 'thread' })
  runtime.effects.splice(0).forEach((fn) => fn())
  return result
}
afterEach(() => {
  runtime.cells = []
  runtime.effects = []
  vi.unstubAllGlobals()
})
function setup(imported = false) {
  const values = new Map([[openingIntentKey('alice', 'thread'), 'new']])
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => values.get(k),
    removeItem: (k: string) => values.delete(k),
  })
  runtime.discussion = {
    owner: 'alice',
    generate: vi.fn(),
    settings: undefined,
  }
  runtime.snapshot = { isImported: imported }
  return values
}
test('headless_new_thread_opening_once_after_ack', () => {
  const values = setup()
  expect(render()).toBeNull()
  expect(runtime.discussion.generate).not.toHaveBeenCalled()
  expect(values.size).toBe(0)
  runtime.discussion.settings = { aiEnabled: true, consentAt: 'ack' }
  render()
  render()
  expect(runtime.discussion.generate).toHaveBeenCalledTimes(1)
  expect(runtime.discussion.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: 'thread',
      kind: 'opening',
      triggerCommentId: null,
    }),
  )
})
test('imports_revisit_focus_back_never_generate', () => {
  setup(true)
  runtime.discussion.settings = { aiEnabled: true, consentAt: 'ack' }
  render()
  expect(runtime.discussion.generate).not.toHaveBeenCalled()
  runtime.cells = []
  runtime.snapshot = { isImported: false }
  render()
  render()
  expect(runtime.discussion.generate).not.toHaveBeenCalled()
})
