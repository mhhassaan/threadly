import type { ThreadRecord } from '../../lib/thread'
import type { ThreadSnapshot } from '../../lib/account-thread'
export function readerSearchParam(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : undefined
}
export type ReaderFocus = {
  postId: string
  commentId?: string
  index: number
} | null
export function resolveReaderFocus(
  search: { post?: string; comment?: string },
  record: ThreadRecord,
  snapshot?: ThreadSnapshot,
  owner?: string,
): ReaderFocus {
  search = {
    post: readerSearchParam(search.post),
    comment: readerSearchParam(search.comment),
  }
  if (!search.post) return null
  let index: number
  if (snapshot) {
    if (!owner || snapshot.thread.ownerId !== owner) return null
    index = snapshot.thread.posts.findIndex((p) => p.id === search.post)
    if (
      index < 0 ||
      (search.comment &&
        !snapshot.comments.some(
          (c) => c.id === search.comment && c.postId === search.post,
        ))
    )
      return null
  } else {
    if (!/^(0|[1-9]\d*)$/.test(search.post)) return null
    index = Number(search.post)
    if (index >= record.posts.length) return null
    if (
      search.comment &&
      (!/^(0|[1-9]\d*)$/.test(search.comment) ||
        !record.interactions[index]?.replies?.[Number(search.comment)])
    )
      return null
  }
  return {
    postId: search.post,
    ...(search.comment ? { commentId: search.comment } : {}),
    index,
  }
}
export function shouldOpenPost(
  target: { closest: (selector: string) => unknown },
  selection: string,
) {
  return (
    !selection &&
    !target.closest(
      'a,button,input,textarea,summary,details,video,audio,iframe,[data-no-open]',
    )
  )
}
export function readerFocusUrl(
  href: string,
  focus: { postId: string; commentId?: string } | null,
) {
  const url = new URL(href)
  url.searchParams.delete('post')
  url.searchParams.delete('comment')
  if (focus) {
    url.searchParams.set('post', focus.postId)
    if (focus.commentId) url.searchParams.set('comment', focus.commentId)
  }
  return url.pathname + url.search + url.hash
}
