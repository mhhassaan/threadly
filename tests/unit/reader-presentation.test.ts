import { afterEach, expect, test, vi } from 'vitest'
import {
  PostFrame,
  PostMenu,
  PostActions,
} from '../../src/components/PostChrome'
import { Post } from '../../src/components/Post'
const runtime = vi.hoisted(() => ({ cells: [] as any[], cursor: 0 }))
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
  useRef(value: any) {
    return (runtime.cells[runtime.cursor++] ??= { current: value })
  },
  useEffect() {},
}))
function find(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  for (const child of [
    node.props?.children,
    node.props?.menu,
    node.props?.selection,
  ].flat(Infinity)) {
    const result = find(child, match)
    if (result) return result
  }
}
const record = {
  id: 'local',
  title: 'Source',
  posts: ['Original source'],
  sourceText: 'Full unchanged source',
  sourceUrl: '',
  source: null,
  media: [],
  interactions: {},
}
const callbacks = {
  onSelect: vi.fn(),
  onEdit: vi.fn(),
  onReact: vi.fn(),
  onReply: vi.fn(),
  onCopy: vi.fn(),
  onShare: vi.fn(),
  onExport: vi.fn(),
  onImage: vi.fn(),
}
function render() {
  runtime.cursor = 0
  return Post({
    record,
    index: 0,
    selected: false,
    selectionMode: false,
    ...callbacks,
  })
}
afterEach(() => {
  runtime.cells = []
  vi.clearAllMocks()
})
test('ordinary_reader_has_no_management_chrome_or_textbox', () => {
  const tree = render()
  expect(
    find(tree, (n) => n.props?.contentEditable || n.type === 'textarea'),
  ).toBeUndefined()
  expect(
    find(tree, (n) => n.props?.className === 'posttext').props.children,
  ).toBe('Original source')
  expect(callbacks.onEdit).not.toHaveBeenCalled()
})
test('explicit_edit_save_cancel_preserves_source_and_draft', () => {
  let tree = render()
  find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Edit post',
  ).props.onClick()
  tree = render()
  find(tree, (n) => n.type === 'textarea').props.onChange({
    target: { value: 'Edited post' },
  })
  tree = render()
  find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Cancel',
  ).props.onClick()
  expect(callbacks.onEdit).not.toHaveBeenCalled()
  tree = render()
  find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Edit post',
  ).props.onClick()
  tree = render()
  find(tree, (n) => n.type === 'textarea').props.onChange({
    target: { value: 'Saved edit' },
  })
  tree = render()
  find(
    tree,
    (n) => n.type === 'button' && n.props.children === 'Save',
  ).props.onClick()
  expect(callbacks.onEdit).toHaveBeenCalledWith(0, 'Saved edit')
  expect(record.sourceText).toBe('Full unchanged source')
})

test('nested_media_action_and_text_selection_do_not_open_actual_post', () => {
  const open = vi.fn()
  vi.stubGlobal('window', {
    getSelection: () => ({ toString: () => 'selected' }),
  })
  const tree = PostFrame({
    name: 'Reader',
    handle: '@reader',
    onOpen: open,
    children: 'source',
  })
  const event = (nested: boolean) => ({
    target: { closest: () => (nested ? {} : null) },
  })
  tree.props.onClick(event(false))
  expect(open).not.toHaveBeenCalled()
  vi.stubGlobal('window', { getSelection: () => ({ toString: () => '' }) })
  tree.props.onClick(event(true))
  expect(open).not.toHaveBeenCalled()
  tree.props.onClick(event(false))
  expect(open).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})
test('keyboard_focus_and_menu_escape_restore_trigger', () => {
  const focus = vi.fn(),
    preventDefault = vi.fn(),
    details = { open: true, querySelector: () => ({ focus }) }
  const tree = PostMenu({ label: 'More options', children: null })
  tree.props.onKeyDown({
    key: 'Escape',
    currentTarget: details,
    preventDefault,
  })
  expect(details.open).toBe(false)
  expect(focus).toHaveBeenCalledOnce()
  expect(preventDefault).toHaveBeenCalledOnce()
  const open = vi.fn(),
    row = PostFrame({ name: 'A', handle: '@a', children: '', onOpen: open }),
    target = {}
  row.props.onKeyDown({
    key: 'Enter',
    currentTarget: target,
    target,
    preventDefault,
  })
  expect(open).toHaveBeenCalledOnce()
  row.props.onKeyDown({
    key: 'Enter',
    currentTarget: target,
    target: {},
    preventDefault,
  })
  expect(open).toHaveBeenCalledOnce()
})
test('actions_dispatch_the_selected_flag_without_invented_counts', () => {
  const react = vi.fn(),
    reply = vi.fn(),
    share = vi.fn()
  const tree = PostActions({
    state: { liked: true },
    replies: 2,
    onReply: reply,
    onReact: react,
    onShare: share,
  })
  find(tree, (n) => n.props?.['aria-label'] === 'Unlike post').props.onClick()
  expect(react).toHaveBeenCalledWith('liked')
  find(tree, (n) => n.props?.['aria-label'] === 'Reply to post').props.onClick()
  expect(reply).toHaveBeenCalledOnce()
  find(
    tree,
    (n) => n.props?.['aria-label'] === 'Copy link to post',
  ).props.onClick()
  expect(share).toHaveBeenCalledOnce()
})
