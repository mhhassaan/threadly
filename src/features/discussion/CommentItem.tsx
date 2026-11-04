import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { PostFrame, PostMenu, PostActions } from '../../components/PostChrome'
import { readerFocusUrl } from '../reader/ReaderNavigation'
import { saveCommentReaction, accountRequest } from '../account/library'
import type {
  Comment,
  MemoryItem,
  CommentReaction,
} from '../../lib/account-thread'
import { splitSource } from '../../server/discussion/source'
export function CommentItem({
  owner,
  comment,
  name,
  parent,
  onReply,
  sourceText,
  reaction,
  onReaction,
  onOpen,
  replyCount,
  handle,
}: {
  owner: string
  comment: Comment
  name: string
  parent: Comment | null
  onReply: () => void
  sourceText: string
  handle?: string
  reaction?: CommentReaction
  onReaction?: (state: CommentReaction) => void
  onOpen?: () => void
  replyCount?: number
}) {
  const [memory, setMemory] = useState<{
    loading: boolean
    items: MemoryItem[]
    error: string
  } | null>(null)
  const request = useRef<AbortController | null>(null)
  const inspectButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => request.current?.abort(), [])
  function closeMemory() {
    request.current?.abort()
    setMemory(null)
    requestAnimationFrame(() =>
      inspectButton.current
        ?.closest('details.post-more')
        ?.querySelector('summary')
        ?.focus(),
    )
  }
  async function inspectMemory() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setMemory({ loading: true, items: [], error: '' })
    try {
      const query = new URLSearchParams(
        comment.usedMemoryIds.map((id) => ['id', id]),
      )
      const items = await accountRequest<MemoryItem[]>(
        '/api/memory?' + query,
        'GET',
        undefined,
        controller.signal,
        owner,
      )
      if (!controller.signal.aborted)
        setMemory({ loading: false, items, error: '' })
    } catch {
      if (!controller.signal.aborted)
        setMemory({
          loading: false,
          items: [],
          error: 'Unable to load remembered context. Close and try again.',
        })
    }
  }
  const [actionError, setActionError] = useState(''),
    [busy, setBusy] = useState(false)
  const reactionRequest = useRef<AbortController | null>(null)
  useEffect(() => () => reactionRequest.current?.abort(), [owner, comment.id])
  async function react(key: keyof CommentReaction) {
    if (reactionRequest.current) return
    const controller = new AbortController()
    reactionRequest.current = controller
    setBusy(true)
    setActionError('')
    try {
      const next = await saveCommentReaction(
        owner,
        comment.id,
        { [key]: !reaction?.[key] },
        controller.signal,
      )
      if (!controller.signal.aborted) onReaction?.(next)
    } catch (error) {
      if (!controller.signal.aborted)
        setActionError(
          error instanceof Error
            ? error.message
            : 'Could not save reaction. Try again.',
        )
    } finally {
      if (!controller.signal.aborted) {
        reactionRequest.current = null
        setBusy(false)
      }
    }
  }
  const passages = splitSource(sourceText).filter((p) =>
    comment.passageIds.includes(p.id),
  )
  return (
    <PostFrame
      name={name}
      handle={
        handle ? '@' + handle : comment.authorKind === 'human' ? '@you' : ''
      }
      ai={comment.authorKind === 'ai'}
      id={'comment-' + comment.id}
      onOpen={onOpen}
      meta={
        comment.createdAt ? (
          <time dateTime={comment.createdAt}>
            {new Date(comment.createdAt).toLocaleDateString()}
          </time>
        ) : undefined
      }
      menu={
        <PostMenu label={'More options for ' + name}>
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(comment.text)
                .catch(() => setActionError('Could not copy this reply.'))
            }}
          >
            Copy reply
          </button>
          {passages.length > 0 && (
            <details className="discussion-sources">
              <summary>Source references ({passages.length})</summary>
              {passages.map((p) => (
                <blockquote key={p.id}>{p.text}</blockquote>
              ))}
            </details>
          )}
          {comment.usedMemoryIds.length > 0 && (
            <button
              ref={inspectButton}
              className="text-button discussion-memory-button"
              onClick={inspectMemory}
            >
              Remembered context ({comment.usedMemoryIds.length})
            </button>
          )}
        </PostMenu>
      }
    >
      {parent && (
        <a
          className="discussion-parent"
          href={
            typeof location === 'undefined'
              ? '#comment-' + parent.id
              : readerFocusUrl(location.href, {
                  postId: comment.postId,
                  commentId: parent.id,
                })
          }
        >
          Replying to {parent.authorKind === 'ai' ? 'an AI participant' : 'you'}
        </a>
      )}
      <div className="posttext">{comment.text}</div>
      {memory && (
        <Dialog title="Remembered context" onClose={closeMemory}>
          <p>
            Historical quotes from your comments supplied to {name}. These
            statements may have changed and are not independently verified
            facts.
          </p>
          {memory.loading && <p role="status">Loading remembered context...</p>}
          {memory.error && <p role="alert">{memory.error}</p>}
          {!memory.loading && !memory.error && memory.items.length === 0 && (
            <p>This context is no longer available or memory is paused.</p>
          )}
          {memory.items.map((item) => (
            <section
              key={item.id}
              className="discussion-sources discussion-memory-quote"
            >
              <blockquote>{item.text}</blockquote>
              {item.evidence.map((e) => (
                <p key={e.id}>
                  <a href={'/?thread=' + encodeURIComponent(e.threadId)}>
                    Open supporting thread
                  </a>
                  {' - '}
                  {new Date(e.createdAt).toLocaleDateString()}
                </p>
              ))}
            </section>
          ))}
        </Dialog>
      )}
      <PostActions
        state={reaction ?? {}}
        replies={replyCount}
        onReply={onReply}
        onReact={(key) => void react(key)}
        onShare={() => {
          void navigator.clipboard
            .writeText(
              location.origin +
                readerFocusUrl(location.href, {
                  postId: comment.postId,
                  commentId: comment.id,
                }),
            )
            .catch(() => setActionError('Could not copy this private link.'))
        }}
        busy={busy}
      />
      {actionError && <p role="alert">{actionError}</p>}
    </PostFrame>
  )
}
