import { DeleteConversation } from './DeleteConversation'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DiscussionContext,
  useThreadDiscussion,
  useDiscussion,
} from './useDiscussion'
import { CommentItem } from './CommentItem'
import { CommentComposer } from './CommentComposer'
import { getCast } from '../../server/discussion/cast'
import { useCloudThread } from '../account/library'
export function ThreadDiscussion({
  threadId,
  children,
}: {
  threadId: string
  children: ReactNode
}) {
  const discussion = useThreadDiscussion(threadId)
  return <DiscussionContext value={discussion}>{children}</DiscussionContext>
}
export function Discussion({
  threadId,
  postId,
  lead = false,
  replyRequest = 0,
}: {
  threadId: string
  postId: string
  lead?: boolean
  replyRequest?: number
}) {
  const discussion = useDiscussion(threadId, postId)
  const snapshot = useCloudThread(discussion.owner, threadId).data
  const comments = snapshot?.comments.filter((c) => c.postId === postId) ?? []
  const previousCommentCount = useRef(comments.length)
  useLayoutEffect(() => {
    if (previousCommentCount.current > 0 && !comments.length)
      document.getElementById('start-discussion-' + threadId)?.focus()
    previousCommentCount.current = comments.length
  }, [comments.length, threadId])
  const [expanded, setExpanded] = useState(lead)
  const focusReply = useRef(false)
  const cast = getCast(threadId)
  const shown = expanded ? comments : comments.slice(0, 2)
  function reply(id: string | null) {
    focusReply.current = true
    setExpanded(true)
    discussion.setReplyToId(id)
  }
  useLayoutEffect(() => {
    if (replyRequest) reply(null)
  }, [replyRequest])
  useLayoutEffect(() => {
    if (expanded && focusReply.current) {
      focusReply.current = false
      document.getElementById('discussion-reply-' + postId)?.focus()
    }
  }, [expanded, discussion.replyToId, replyRequest])
  const parent = comments.find((c) => c.id === discussion.replyToId)
  return (
    <section className="post-discussion" aria-label="Private discussion">
      {comments.length > 0 && (
        <div className="discussion-heading">
          <span>
            Discussion · {comments.length}{' '}
            {comments.length === 1 ? 'comment' : 'comments'}
          </span>
          <DeleteConversation
            owner={discussion.owner}
            threadId={threadId}
            postId={postId}
            onDeleted={() => discussion.setReplyToId(null)}
          />
          <button
            className="text-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      )}
      <div className="discussion-comments">
        {shown.map((comment) => (
          <CommentItem
            key={comment.id}
            owner={discussion.owner}
            comment={comment}
            name={
              comment.authorKind === 'human'
                ? discussion.name
                : cast.find((p) => p.id === comment.authorId)?.name ||
                  'AI participant'
            }
            parent={comments.find((c) => c.id === comment.parentId) ?? null}
            sourceText={snapshot?.thread.record.sourceText ?? ''}
            onReply={() => reply(comment.id)}
          />
        ))}
      </div>
      {!expanded && comments.length > 2 && (
        <button className="text-button" onClick={() => setExpanded(true)}>
          View all {comments.length} comments
        </button>
      )}
      {lead || expanded ? (
        <>
          {parent && (
            <div className="discussion-replying">
              Replying to{' '}
              {parent.authorKind === 'human'
                ? discussion.name
                : cast.find((p) => p.id === parent.authorId)?.name ||
                  'AI participant'}{' '}
              <button className="text-button" onClick={() => reply(null)}>
                Cancel reply
              </button>
            </div>
          )}
          <CommentComposer
            key={postId + ':' + (discussion.replyToId ?? 'post')}
            threadId={threadId}
            postId={postId}
            parentId={discussion.replyToId}
            onSaved={() => {}}
          />
        </>
      ) : (
        <button
          className="text-button discussion-open"
          onClick={() => reply(null)}
        >
          Reply to this post
        </button>
      )}
    </section>
  )
}
