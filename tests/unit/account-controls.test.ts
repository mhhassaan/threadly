import { afterEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { PrivacyPanel } from '../../src/features/account/PrivacyPanel'
import {
  ThreadManagement,
  ManagedThread,
} from '../../src/features/account/ThreadManagement'
import { DeleteConversation } from '../../src/features/discussion/DeleteConversation'
const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  settings: { aiEnabled: true, consentAt: 'receipt', memoryEnabled: false },
  snapshot: undefined as any,
  library: [] as any[],
  discussion: {} as any,
  request: vi.fn(),
  client: null as any,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(value: any) {
    const i = runtime.cursor++
    if (!(i in runtime.cells)) runtime.cells[i] = value
    return [runtime.cells[i], (next: any) => (runtime.cells[i] = next)]
  },
  useRef(value: any) {
    const i = runtime.cursor++
    return (runtime.cells[i] ??= { current: value })
  },
  useEffect() {},
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => runtime.client,
  useQuery: ({ queryKey }: any) => ({
    data: queryKey.at(-1) === 'settings' ? runtime.settings : [],
    isPending: false,
  }),
}))
vi.mock('../../src/features/account/auth-client', () => ({
  useAccountStatus: () => ({}),
}))
vi.mock('../../src/features/account/library', () => ({
  accountRequest: (...args: any[]) => runtime.request(...args),
  accountThreadKey: (owner: string, id: string) => [
    'account',
    owner,
    'thread',
    id,
  ],
  useCloudLibrary: () => ({ data: { pages: [{ threads: runtime.library }] } }),
  useCloudThread: () => ({ data: runtime.snapshot }),
}))
vi.mock('../../src/features/discussion/useDiscussion', () => ({
  useThreadDiscussion: () => runtime.discussion,
}))
function find(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, match)
    if (found) return found
  }
}
function reset() {
  runtime.cells = []
  runtime.cursor = 0
  runtime.client = new QueryClient()
  runtime.request.mockReset()
  runtime.settings = {
    aiEnabled: true,
    consentAt: 'receipt',
    memoryEnabled: false,
  }
}
function render<T>(fn: () => T) {
  runtime.cursor = 0
  return fn()
}
afterEach(() => vi.unstubAllGlobals())
test('account_defaults_pause_explicitly_and_legacy_acknowledges', async () => {
  reset()
  runtime.request.mockResolvedValue({ ...runtime.settings, aiEnabled: false })
  let tree = render(() => PrivacyPanel({ owner: 'alice' }))
  expect(
    find(
      tree,
      (n) => n.type === 'button' && n.props.children === 'Enable memory',
    ),
  ).toBeTruthy()
  await find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Pause AI',
  ).props.onClick()
  expect(runtime.request.mock.calls[0].slice(0, 3)).toEqual([
    '/api/settings',
    'PATCH',
    { aiEnabled: false },
  ])
  runtime.settings = {
    aiEnabled: false,
    consentAt: null as any,
    memoryEnabled: false,
  }
  tree = render(() => PrivacyPanel({ owner: 'alice' }))
  await find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Agree and enable AI',
  ).props.onClick()
  expect(runtime.request.mock.calls[1][2]).toEqual({
    aiEnabled: true,
    acknowledgeConsent: true,
  })
})
test('management_selects_lazily_and_rejects_another_owner', () => {
  reset()
  runtime.library = [
    { id: 'thread', ownerId: 'alice', record: { title: 'Saved' } },
  ]
  let tree = render(() => ThreadManagement({ owner: 'alice' }))
  expect(find(tree, (n) => n.type === ManagedThread)).toBeUndefined()
  find(tree, (n) => n.type === 'select').props.onChange({
    target: { value: 'thread' },
  })
  tree = render(() => ThreadManagement({ owner: 'alice' }))
  expect(find(tree, (n) => n.type === ManagedThread).props).toMatchObject({
    owner: 'alice',
    threadId: 'thread',
  })
  tree = render(() => ThreadManagement({ owner: 'bob' }))
  expect(find(tree, (n) => n.type === ManagedThread)).toBeUndefined()
})
test('managed_post_uses_existing_delete_and_only_explicit_restart', async () => {
  reset()
  runtime.snapshot = {
    thread: {
      ownerId: 'alice',
      posts: [{ id: 'post', text: 'Source', position: 0 }],
    },
  }
  runtime.discussion = {
    owner: 'alice',
    settings: runtime.settings,
    restart: vi.fn(),
    refresh: vi.fn(),
  }
  let tree = render(() => ManagedThread({ owner: 'alice', threadId: 'thread' }))
  expect(runtime.discussion.restart).not.toHaveBeenCalled()
  find(tree, (n) => n.type === 'select').props.onChange({
    target: { value: 'post' },
  })
  tree = render(() => ManagedThread({ owner: 'alice', threadId: 'thread' }))
  const deletion = find(tree, (n) => n.type === DeleteConversation)
  expect(deletion.props).toMatchObject({
    owner: 'alice',
    threadId: 'thread',
    postId: 'post',
  })
  deletion.props.onDeleted()
  expect(runtime.discussion.refresh).toHaveBeenCalledOnce()
  await find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Restart discussion',
  ).props.onClick()
  expect(runtime.discussion.restart).toHaveBeenCalledOnce()
  runtime.discussion.owner = 'bob'
  tree = render(() => ManagedThread({ owner: 'alice', threadId: 'thread' }))
  expect(find(tree, (n) => n.type === DeleteConversation)).toBeUndefined()
})
