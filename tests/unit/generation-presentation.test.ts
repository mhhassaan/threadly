import { afterEach, expect, test, vi } from 'vitest'
import { Post } from '../../src/components/Post'
import { retrieveGenerationSource } from '../../src/server/thread-generation/source'
import { createThreadImage } from '../../src/lib/export.js'
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: any) => [value, vi.fn()],
  useRef: () => ({ current: null }),
  useEffect: () => {},
}))
const record: any = {
  id: 'synthetic',
  title: 'Evidence',
  posts: ['A complete thought.'],
  sourceUrl: '',
  source: null,
  media: [],
  interactions: {},
}
function find(node: any, match: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, match)
    if (found) return found
  }
}
function post(value: any) {
  return Post({
    record: value,
    index: 0,
    selected: false,
    selectionMode: false,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onReact: vi.fn(),
    onReply: vi.fn(),
    onCopy: vi.fn(),
    onShare: vi.fn(),
    onExport: vi.fn(),
    onImage: vi.fn(),
  })
}
afterEach(() => vi.unstubAllGlobals())
test('reader shows a human date while retaining the machine timestamp', () => {
  const date = '2026-11-09T11:44:19.551Z'
  const view = post({ ...record, date })
  const time = find(view, (n) => n.type === 'time')
  expect(time?.props.dateTime).toBe(date)
  expect(time?.props.children).toBe('Nov 9, 2026')
})
test.each(['11/9/2026', '9 November 2026', 'Unknown date'])(
  'legacy date stays readable: %s',
  (date) => {
    const view = post({ ...record, date })
    expect(find(view, (n) => n.props?.children === date)).toBeDefined()
  },
)
test.each(['text', 'file'] as const)(
  'attributed %s source reaches reader and PNG consumers',
  async (mode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('no network allowed')
      }),
    )
    const source = await retrieveGenerationSource(
      { env: {} } as any,
      {
        mode,
        source: 'Source: https://www.example.org/article\nOriginal evidence.',
      } as any,
      new AbortController().signal,
    )
    const value = {
      ...record,
      sourceUrl: source.sourceUrl,
      source: source.source,
    }
    const view = post(value)
    expect(view.props.name).toBe('example.org')
    expect(view.props.handle).toBe('@example.org')
    expect(view.props.image).toBe('https://www.example.org/favicon.ico')
    expect(
      find(view, (n) => n.type === 'a' && n.props.children === 'Source')?.props
        .href,
    ).toBe('https://www.example.org/article')
    const painted: string[] = []
    const context = {
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      arc() {},
      fill() {},
      fillText: (s: string) => painted.push(s),
    }
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => context,
        toBlob: (fn: any) => fn(new Blob(['fake canvas bytes'])),
      }),
    })
    vi.stubGlobal('Image', undefined)
    await createThreadImage({
      ...value,
      indices: [0],
      theme: {
        surface: '#fff',
        text: '#000',
        muted: '#777',
        line: '#aaa',
        accent: '#00f',
        accentInk: '#fff',
      },
    })
    expect(painted).toContain('example.org')
    expect(painted).toContain('@example.org')
    expect(painted).toContain('Source: https://www.example.org/article')
  },
)
