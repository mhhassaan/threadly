import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { CloudLibrary } from '../../src/features/account/CloudLibrary'
import { useCloudReader } from '../../src/features/account/useCloudReader'
import { DeleteConversation } from '../../src/features/discussion/DeleteConversation'
import { draftKey } from '../../src/features/account/auth-state'
import { ApiError } from '../../src/lib/account-thread'

const runtime = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  pending: [] as any[],
  query: {} as any,
  library: {} as any,
  client: null as any,
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: any) {
    const i = runtime.cursor++
    const cells = runtime.cells
    if (!(i in runtime.cells))
      runtime.cells[i] = typeof initial === 'function' ? initial() : initial
    return [
      runtime.cells[i],
      (next: any) => {
        cells[i] = typeof next === 'function' ? next(cells[i]) : next
      },
    ]
  },
  useRef(initial: any) {
    return (runtime.cells[runtime.cursor++] ??= { current: initial })
  },
  useEffect(fn: any, deps: any[]) {
    const i = runtime.cursor++,
      previous = runtime.cells[i]
    if (!previous || deps.some((d, j) => d !== previous.deps[j])) {
      runtime.pending.push(() => {
        previous?.cleanup?.()
        runtime.cells[i] = { deps, cleanup: fn() }
      })
    }
  },
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => runtime.client,
  useQuery: () => runtime.query,
  useInfiniteQuery: () => runtime.library,
}))
function render<T>(fn: () => T) {
  runtime.cursor = 0
  const result = fn()
  runtime.pending.splice(0).forEach((effect) => effect())
  return result
}
function find(node: any, predicate: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate)
    if (found) return found
  }
}
function snapshot(owner = 'alice'): any {
  return {
    thread: {
      id: 'thread',
      ownerId: owner,
      revision: 1,
      sourceRevision: 1,
      record: {
        id: 'thread',
        title: 'Private source',
        sourceText: 'Private article',
        posts: ['Post', 'Other'],
        sourceUrl: '',
        source: null,
        media: [],
        interactions: {},
      },
      posts: [
        { id: 'post', position: 0, text: 'Post', revision: 1 },
        { id: 'other', position: 1, text: 'Other', revision: 1 },
      ],
    },
    comments: [
      {
        id: 'comment',
        postId: 'post',
        text: 'Deleted discussion',
        createdAt: '2026-01-01',
        sequence: 1,
      },
    ],
    readPostId: null,
    readAt: null,
  }
}
function storeDraft(owner = 'alice') {
  const base = snapshot(owner)
  const draft = {
    record: {
      ...base.thread.record,
      posts: ['Unsaved edit', 'Other'],
      interactions: {
        '0': {
          liked: true,
          replies: [{ text: 'Deleted discussion', date: '2026-01-01' }],
        },
      },
    },
    base,
  }
  sessionStorage.setItem(
    draftKey(owner, 'thread:thread'),
    JSON.stringify(draft),
  )
  return draft
}
beforeEach(() => {
  runtime.cells = []
  runtime.pending = []
  runtime.cursor = 0
  runtime.client = new QueryClient()
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    get length() {
      return values.size
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('requestAnimationFrame', (fn: any) => {
    fn()
    return 0
  })
  vi.stubGlobal('document', { getElementById: () => null })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  )
  runtime.query = { data: snapshot(), error: null, refetch: vi.fn() }
  runtime.library = { data: { pages: [{ threads: [snapshot().thread] }] } }
})
afterEach(() => {
  for (const cell of runtime.cells) cell?.cleanup?.()
  vi.unstubAllGlobals()
})

test('existing_full_draft_successful_DELETE_then_reopen_cannot_read_deleted_source', async () => {
  storeDraft()
  sessionStorage.setItem('threadly-library', 'guest original')
  sessionStorage.setItem(draftKey('bob', 'thread:thread'), 'other owner')
  let tree = render(() => CloudLibrary({ owner: 'alice', local: [] }))
  find(tree, (n) => n.props?.className === 'delete-saved').props.onClick({
    currentTarget: null,
  })
  tree = render(() => CloudLibrary({ owner: 'alice', local: [] }))
  find(tree, (n) => n.props?.className === 'account-discard').props.onClick()
  await vi.waitFor(() =>
    expect(
      sessionStorage.getItem(draftKey('alice', 'thread:thread')),
    ).toBeNull(),
  )
  runtime.cells = []
  runtime.query = { error: new ApiError(404, 'NOT_FOUND', 'Thread not found') }
  expect(render(() => useCloudReader('alice', 'thread')).record).toBeNull()
  expect(sessionStorage.getItem('threadly-library')).toBe('guest original')
  expect(sessionStorage.getItem(draftKey('bob', 'thread:thread'))).toBe(
    'other owner',
  )
})

test('authenticated_remote404_clears_existing_mounted_draft_and_cached_source', () => {
  storeDraft()
  expect(render(() => useCloudReader('alice', 'thread')).record?.posts[0]).toBe(
    'Unsaved edit',
  )
  runtime.query = {
    data: snapshot(),
    error: new ApiError(404, 'NOT_FOUND', 'Thread not found'),
  }
  expect(render(() => useCloudReader('alice', 'thread')).record).toBeNull()
  expect(sessionStorage.getItem(draftKey('alice', 'thread:thread'))).toBeNull()
  expect(render(() => useCloudReader('alice', 'thread')).draft).toBeNull()
  expect(render(() => useCloudReader('alice', 'thread')).notFound).toBe(true)
})

test('late_ownerA404_does_not_erase_ownerB_mounted_draft', async () => {
  storeDraft('alice')
  const readerA = render(() => useCloudReader('alice', 'thread'))
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const pending = readerA.save()
  for (const cell of runtime.cells) cell?.cleanup?.()
  runtime.cells = []
  storeDraft('bob')
  runtime.query = { data: snapshot('bob'), error: null }
  render(() => useCloudReader('bob', 'thread'))
  finish(
    Response.json(
      { code: 'NOT_FOUND', message: 'Thread not found' },
      { status: 404 },
    ),
  )
  await pending
  expect(render(() => useCloudReader('bob', 'thread')).record?.posts[0]).toBe(
    'Unsaved edit',
  )
  expect(
    sessionStorage.getItem(draftKey('bob', 'thread:thread')),
  ).not.toBeNull()
})

test('successful_delete_clears_mounted_reader_and_fences_late_save_response', async () => {
  storeDraft()
  const cells: any[] = []
  runtime.cells = cells
  const reader = render(() => useCloudReader('alice', 'thread'))
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: any, init: any) =>
      init.method === 'PATCH'
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(new Response(null, { status: 204 })),
    ),
  )
  const pending = reader.save()
  runtime.cells = []
  const component = () => CloudLibrary({ owner: 'alice', local: [] })
  let tree = render(component)
  find(tree, (n) => n.props?.className === 'delete-saved').props.onClick({
    currentTarget: null,
  })
  tree = render(component)
  find(tree, (n) => n.props?.className === 'account-discard').props.onClick()
  await vi.waitFor(() =>
    expect(
      sessionStorage.getItem(draftKey('alice', 'thread:thread')),
    ).toBeNull(),
  )
  finish(Response.json(snapshot()))
  await pending
  runtime.cells = cells
  expect(render(() => useCloudReader('alice', 'thread')).record).toBeNull()
  expect(render(() => useCloudReader('alice', 'thread')).draft).toBeNull()
  expect(
    runtime.client.getQueryData(['account', 'alice', 'thread', 'thread']),
  ).toBeUndefined()
})

test.each([0, 401, 503])(
  'error_%s_keeps_same_owner_draft_recovery',
  (status) => {
    storeDraft()
    runtime.query.error = new ApiError(status, 'FAILURE', 'Try again')
    expect(
      render(() => useCloudReader('alice', 'thread')).record?.posts[0],
    ).toBe('Unsaved edit')
    expect(
      sessionStorage.getItem(draftKey('alice', 'thread:thread')),
    ).not.toBeNull()
  },
)

test('conversation_delete_scrubs_full_base_and_mounted_draft_but_keeps_source_edits', async () => {
  storeDraft()
  const readerCells: any[] = []
  runtime.cells = readerCells
  render(() => useCloudReader('alice', 'thread'))
  runtime.cells = []
  const component = () =>
    DeleteConversation({
      owner: 'alice',
      threadId: 'thread',
      postId: 'post',
      onDeleted() {},
    })
  let tree = render(component)
  find(tree, (n) => n.type === 'button').props.onClick()
  tree = render(component)
  find(tree, (n) => n.props?.className === 'account-discard').props.onClick()
  await vi.waitFor(() =>
    expect(
      JSON.parse(sessionStorage.getItem(draftKey('alice', 'thread:thread'))!)
        .base.comments,
    ).toEqual([]),
  )
  runtime.cells = readerCells
  const reader = render(() => useCloudReader('alice', 'thread'))
  expect(reader.record?.posts[0]).toBe('Unsaved edit')
  expect(JSON.stringify(reader.draft)).not.toContain('Deleted discussion')
})
