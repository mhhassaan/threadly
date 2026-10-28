import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { createReplyComposer } from '../../src/features/account/reply-composer'
import { ThreadReplyComposer } from '../../src/components/Post'
import { Replies } from '../../src/components/Replies'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
afterEach(() => vi.unstubAllGlobals())

test('shared reply lifecycle retains failed draft and clears only a successful deliberate retry', async () => {
  const drafts = storage(),
    key = 'threadly-account:alice:draft:reply'
  drafts.setItem(key, 'Restored unsent reply')
  let finish!: (result: boolean) => void
  const submissions: string[] = []
  const composer = createReplyComposer(
    (text) => {
      submissions.push(text)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    key,
    drafts,
  )
  expect(composer.snapshot()).toEqual({
    value: 'Restored unsent reply',
    sending: false,
  })
  composer.change('  Edited reply  ')
  expect(drafts.getItem(key)).toBe('  Edited reply  ')
  const pending = composer.submit()
  expect(composer.snapshot().sending).toBe(true)
  expect(await composer.submit()).toBe(false)
  composer.change('Cannot replace draft during submission')
  finish(false)
  expect(await pending).toBe(false)
  expect(composer.snapshot()).toEqual({
    value: '  Edited reply  ',
    sending: false,
  })
  expect(drafts.getItem(key)).toBe('  Edited reply  ')
  expect(submissions).toEqual(['Edited reply'])
  const retry = composer.submit()
  finish(true)
  expect(await retry).toBe(true)
  expect(composer.snapshot()).toEqual({ value: '', sending: false })
  expect(drafts.getItem(key)).toBeNull()
  expect(submissions).toEqual(['Edited reply', 'Edited reply'])
})

test('rejection and unmount cannot clear a replacement owner draft', async () => {
  const drafts = storage(),
    key = 'threadly-account:alice:draft:reply'
  const rejected = createReplyComposer(
    async () => {
      throw Error('offline')
    },
    key,
    drafts,
  )
  rejected.change('Offline draft')
  expect(await rejected.submit()).toBe(false)
  expect(rejected.snapshot()).toEqual({
    value: 'Offline draft',
    sending: false,
  })
  let finish!: (result: boolean) => void
  const old = createReplyComposer(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    key,
    drafts,
  )
  const pending = old.submit()
  old.dispose()
  drafts.setItem(key, 'Newly signed-in draft')
  finish(true)
  expect(await pending).toBe(false)
  expect(drafts.getItem(key)).toBe('Newly signed-in draft')
})

test('inline and modal consumers restore the shared private draft while retaining their labels', () => {
  const drafts = storage(),
    key = 'threadly-account:alice:draft:reply'
  drafts.setItem(key, 'Unsent private reply from storage')
  vi.stubGlobal('sessionStorage', drafts)
  const record = {
    id: crypto.randomUUID(),
    title: 'Reading',
    posts: ['Original post'],
    sourceUrl: '',
    source: null,
    media: [],
    interactions: {},
  }
  const inline = renderToStaticMarkup(
    createElement(ThreadReplyComposer, {
      storageKey: key,
      privateReply: true,
      onReply: () => {},
    }),
  )
  const modal = renderToStaticMarkup(
    createElement(Replies, {
      storageKey: key,
      record,
      index: 0,
      onReply: () => {},
    }),
  )
  for (const markup of [inline, modal])
    expect(markup).toContain('Unsent private reply from storage</textarea>')
  expect(inline).toContain('Post your reply')
  expect(inline).toContain('>Reply</button>')
  expect(modal).toContain('Add a reply')
  expect(modal).toContain('>Add reply</button>')
  expect(drafts.getItem(key)).toBe('Unsent private reply from storage')
})
