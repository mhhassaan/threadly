import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { accountRequest } from '../account/library'
import type { Comment, MemoryItem } from '../../lib/account-thread'
import { splitSource } from '../../server/discussion/source'
export function CommentItem({
  owner,
  comment,
  name,
  parent,
  onReply,
  sourceText,
}: {
  owner: string
  comment: Comment
  name: string
  parent: Comment | null
  onReply: () => void
  sourceText: string
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
    requestAnimationFrame(() => inspectButton.current?.focus())
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
  const passages = splitSource(sourceText).filter((p) =>
    comment.passageIds.includes(p.id),
  )
  return (
    <article
      className={'discussion-comment' + (parent ? ' is-reply' : '')}
      id={'comment-' + comment.id}
    >
      <div className="discussion-avatar" aria-hidden="true">
        {name.slice(0, 1)}
      </div>
      <div className="discussion-comment-body">
        <div className="discussion-author">
          <strong>{name}</strong>
          {comment.authorKind === 'ai' && <span className="ai-label">AI</span>}
        </div>
        {parent && (
          <a className="discussion-parent" href={'#comment-' + parent.id}>
            In reply to{' '}
            {parent.authorKind === 'ai' ? 'an AI participant' : 'you'}
          </a>
        )}
        <p>{comment.text}</p>
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
        {memory && (
          <Dialog title="Remembered context" onClose={closeMemory}>
            <p>
              Historical quotes from your comments supplied to {name}. These
              statements may have changed and are not independently verified
              facts.
            </p>
            {memory.loading && (
              <p role="status">Loading remembered context...</p>
            )}
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
        <button
          className="text-button"
          onClick={onReply}
          aria-label={'Reply to ' + name}
        >
          Reply
        </button>
      </div>
    </article>
  )
}
