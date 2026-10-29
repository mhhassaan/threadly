import { useRef } from 'react'
import type { AppendCommentInput } from '../../lib/account-thread'
import { draftKey } from '../account/auth-state'
import { ThreadReplyComposer } from '../../components/Post'
import { useDiscussion } from './useDiscussion'
export function CommentComposer({
  threadId,
  postId,
  parentId,
  onSaved,
}: {
  threadId: string
  postId: string
  parentId: string | null
  onSaved: () => void
}) {
  const discussion = useDiscussion(threadId, postId)
  const key = draftKey(
    discussion.owner,
    'comment:' + threadId + ':' + postId + ':' + parentId,
  )
  const requestKey = key + ':request'
  const pending = useRef<AppendCommentInput | null>(null)
  return (
    <ThreadReplyComposer
      inputId={'discussion-reply-' + postId}
      storageKey={key}
      privateReply
      onReply={async (text) => {
        let input = pending.current
        if (!input) {
          try {
            input = JSON.parse(sessionStorage.getItem(requestKey) || 'null')
          } catch {}
        }
        if (
          !input ||
          input.text !== text ||
          input.parentId !== parentId ||
          input.threadId !== threadId ||
          input.postId !== postId
        )
          input = { id: crypto.randomUUID(), threadId, postId, parentId, text }
        pending.current = input
        try {
          sessionStorage.setItem(requestKey, JSON.stringify(input))
        } catch {}
        const saved = await discussion.submit(input)
        if (saved) {
          pending.current = null
          try {
            sessionStorage.removeItem(requestKey)
          } catch {}
          onSaved()
          document.getElementById('discussion-reply-' + postId)?.focus()
        }
        return saved
      }}
    />
  )
}
