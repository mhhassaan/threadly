import { useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DiscussionContext,
  useThreadDiscussion,
  useDiscussion,
} from './useDiscussion'
import { CommentItem } from './CommentItem'
import { CommentComposer } from './CommentComposer'
import { getCast } from '../../server/discussion/cast'
import { useCloudThread, accountThreadKey } from '../account/library'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, type ThreadSnapshot } from '../../lib/account-thread'
export function ThreadDiscussion({
  threadId,
  children,
}: {
  threadId: string
  children: ReactNode
}) {
  const discussion = useThreadDiscussion(threadId)
  const query = useCloudThread(discussion.owner, threadId)
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 404)
      discussion.dispose()
  }, [query.error])
  return <DiscussionContext value={discussion}>{children}</DiscussionContext>
}
export function Discussion({
  threadId,
  postId,
  commentId,
  replyRequest = 0,
  onOpen,
}: {
  threadId: string
  postId: string
  commentId?: string
  replyRequest?: number
  onOpen?: (id: string) => void
}) {
  const discussion = useDiscussion(threadId, postId)
  const snapshot = useCloudThread(discussion.owner, threadId).data
  const client = useQueryClient()
  const comments = snapshot?.comments.filter((c) => c.postId === postId) ?? []
  const [showAll, setShowAll] = useState(false)
  const cast = getCast(threadId)
  const selected = comments.find((c) => c.id === commentId)
  const branch = selected
    ? comments.filter((c) => c.id === selected.id || c.parentId === selected.id)
    : comments
  const shown = showAll ? branch : branch.slice(0, 12)
  function reply(id: string | null) {
    discussion.setReplyToId(id)
    requestAnimationFrame(() =>
      document.getElementById('discussion-reply-' + postId)?.focus(),
    )
  }
  useLayoutEffect(() => {
    if (replyRequest) reply(commentId ?? null)
  }, [replyRequest, commentId])
  useLayoutEffect(() => {
    discussion.setReplyToId(commentId ?? null)
  }, [commentId])
  const parent = comments.find((c) => c.id === discussion.replyToId)
  return (
    <section className="focused-conversation" aria-label="Replies">
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
      <DiscussionFeedback threadId={threadId} postId={postId} />
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
          handle={
            comment.authorKind === 'ai'
              ? cast.find((p) => p.id === comment.authorId)?.handle
              : undefined
          }
          reaction={snapshot?.commentReactions?.[comment.id]}
          replyCount={comments.filter((c) => c.parentId === comment.id).length}
          onReaction={(reaction) =>
            client.setQueryData<ThreadSnapshot>(
              accountThreadKey(discussion.owner, threadId),
              (previous) =>
                previous
                  ? {
                      ...previous,
                      commentReactions: {
                        ...previous.commentReactions,
                        [comment.id]: reaction,
                      },
                    }
                  : previous,
            )
          }
          onOpen={() => onOpen?.(comment.id)}
          onReply={() => reply(comment.id)}
        />
      ))}
      {!showAll && branch.length > shown.length && (
        <button
          className="text-button more-replies"
          onClick={() => setShowAll(true)}
        >
          Show {branch.length - shown.length} more replies
        </button>
      )}
    </section>
  )
}

export function DiscussionFeedback({
  threadId,
  postId,
}: {
  threadId: string
  postId: string
}) {
  const discussion = useDiscussion(threadId, postId)
  if (!discussion.pending && !discussion.error) return null
  return (
    <div className="reply-feedback" role="status">
      {discussion.pending ? (
        <>
          <span>Preparing replies…</span>
          <button
            disabled={discussion.cancelling}
            onClick={() => void discussion.cancel(discussion.turn?.id)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <span>{discussion.error}</span>
          {discussion.input &&
            !['complete', 'cancelled'].includes(
              discussion.turn?.status ?? '',
            ) && (
              <button
                disabled={!discussion.settings?.aiEnabled}
                onClick={() =>
                  void discussion.retry(discussion.input!.requestId)
                }
              >
                Retry replies
              </button>
            )}
        </>
      )}
    </div>
  )
}
