import { expect, test } from 'vitest'
import {
  resolveReaderFocus,
  shouldOpenPost,
  readerFocusUrl,
} from '../../src/features/reader/ReaderNavigation'
test('owned_and_guest_post_focus_back_and_reply_targets', () => {
  const record: any = {
    posts: ['first', 'second'],
    interactions: { 1: { replies: [{ text: 'local' }] } },
  }
  const snapshot: any = {
    thread: { ownerId: 'alice', posts: [{ id: 'p1' }, { id: 'p2' }] },
    comments: [{ id: 'c1', postId: 'p2' }],
  }
  expect(
    resolveReaderFocus(
      { post: 'p2', comment: 'c1' },
      record,
      snapshot,
      'alice',
    ),
  ).toEqual({ postId: 'p2', commentId: 'c1', index: 1 })
  expect(
    resolveReaderFocus(
      { post: 'p2', comment: 'foreign' },
      record,
      snapshot,
      'alice',
    ),
  ).toBeNull()
  expect(resolveReaderFocus({ post: 'p2' }, record, snapshot, 'bob')).toBeNull()
  expect(resolveReaderFocus({ post: '1', comment: '0' }, record)).toEqual({
    postId: '1',
    commentId: '0',
    index: 1,
  })
  expect(resolveReaderFocus({ post: '2' }, record)).toBeNull()
  expect(readerFocusUrl('https://local/?reader=token', { postId: '1' })).toBe(
    '/?reader=token&post=1',
  )
})
test('nested_media_action_and_text_selection_do_not_open_post', () => {
  expect(shouldOpenPost({ closest: () => null }, '')).toBe(true)
  expect(shouldOpenPost({ closest: () => ({}) }, '')).toBe(false)
  expect(shouldOpenPost({ closest: () => null }, 'selected words')).toBe(false)
})

test('numeric_guest_search_from_copied_link_resolves_to_local_post_and_reply', () => {
  const record: any = {
    posts: ['first', 'second'],
    interactions: { 1: { replies: [{ text: 'local' }] } },
  }
  expect(resolveReaderFocus({ post: 1, comment: 0 } as any, record)).toEqual({
    postId: '1',
    commentId: '0',
    index: 1,
  })
})
