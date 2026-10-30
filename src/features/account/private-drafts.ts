import type { ThreadSnapshot } from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'
import { draftKey } from './auth-state'

export type CloudDraft = {
  record: ThreadRecord
  base: ThreadSnapshot
  readPostId?: string
}
export const privateDeletionEvent = 'threadly:private-deletion'
export type PrivateDeletion = {
  owner: string
  threadId: string
  postId?: string
}

export function scrubConversation(
  draft: CloudDraft,
  postId: string,
): CloudDraft {
  const position = draft.base.thread.posts.find(
    (post) => post.id === postId,
  )?.position
  const scrub = (record: ThreadRecord) => ({
    ...record,
    interactions: Object.fromEntries(
      Object.entries(record.interactions).map(([key, reaction]) => [
        key,
        Number(key) === position ? { ...reaction, replies: [] } : reaction,
      ]),
    ),
  })
  return {
    ...draft,
    record: scrub(draft.record),
    base: {
      ...draft.base,
      openingBlocked: true,
      thread: { ...draft.base.thread, record: scrub(draft.base.thread.record) },
      comments: draft.base.comments.filter(
        (comment) => comment.postId !== postId,
      ),
    },
  }
}

// Called only after confirmed deletion (including an authenticated terminal404).
// Every key and notification is scoped to the originating owner and thread.
export function erasePrivateDrafts(deletion: PrivateDeletion) {
  const { owner, threadId, postId } = deletion
  try {
    const key = draftKey(owner, 'thread:' + threadId)
    let stored: CloudDraft | null = null
    if (!postId) sessionStorage.removeItem(key)
    else
      try {
        stored = JSON.parse(
          sessionStorage.getItem(key) || 'null',
        ) as CloudDraft | null
      } catch {}
    const valid =
      stored?.base?.thread?.ownerId === owner &&
      stored.base.thread.id === threadId
    const position = valid && stored
      ? stored.base.thread.posts.find((post) => post.id === postId)?.position
      : undefined
    if (postId && valid && stored)
      sessionStorage.setItem(
        key,
        JSON.stringify(scrubConversation(stored, postId)),
      )
    const prefix = draftKey(
      owner,
      'comment:' + threadId + ':' + (postId ? postId + ':' : ''),
    )
    const replyPrefix = draftKey(owner, 'reply-request:' + threadId + ':')
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const name = sessionStorage.key(i)
      if (
        name?.startsWith(prefix) ||
        (!postId && name?.startsWith(replyPrefix))
      )
        sessionStorage.removeItem(name!)
    }
    if (position !== undefined)
      sessionStorage.removeItem(
        draftKey(owner, 'reply-request:' + threadId + ':' + position),
      )
    sessionStorage.removeItem(draftKey(owner, 'new-opening:' + threadId))
  } catch {}
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent(privateDeletionEvent, { detail: deletion }),
    )
}
