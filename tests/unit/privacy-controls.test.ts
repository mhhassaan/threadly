import { afterEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { DeleteConversation } from '../../src/features/discussion/DeleteConversation'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as any[],
  client: null as any,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(value: any) {
    const i = runtime.cursor++
    if (!(i in runtime.cells))
      runtime.cells[i] = typeof value === 'function' ? value() : value
    return [
      runtime.cells[i],
      (next: any) => {
        runtime.cells[i] =
          typeof next === 'function' ? next(runtime.cells[i]) : next
      },
    ]
  },
  useRef(value: any) {
    const i = runtime.cursor++
    return (runtime.cells[i] ??= { current: value })
  },
  useEffect(effect: any) {
    runtime.effects.push(effect)
  },
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => runtime.client,
}))
function find(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = find(child, match)
    if (found) return found
  }
}
afterEach(() => vi.unstubAllGlobals())
test('conversation_delete_remains_live_after_strict_effect_replay', async () => {
  runtime.cells = []
  runtime.effects = []
  runtime.cursor = 0
  runtime.client = new QueryClient()
  const done = vi.fn()
  function render() {
    runtime.cursor = 0
    return DeleteConversation({
      owner: 'alice',
      threadId: 'thread',
      postId: 'post',
      onDeleted: done,
    })
  }
  let tree = render()
  const effects = [...runtime.effects],
    cleanups = effects.map((f) => f())
  cleanups.forEach((f) => f?.())
  effects.forEach((f) => f())
  find(tree, (n) => n.type === 'button').props.onClick()
  tree = render()
  const fetch = vi.fn(async (_path: any, init: any) => {
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('document', { getElementById: () => null })
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('requestAnimationFrame', (fn: any) => {
    fn()
    return 0
  })
  await find(
    tree,
    (n) => n.type === 'button' && n.props.className === 'account-discard',
  ).props.onClick()
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false)
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
})
