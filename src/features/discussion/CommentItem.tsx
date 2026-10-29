import type { Comment } from '../../lib/account-thread'
import { splitSource } from '../../server/discussion/source'
export function CommentItem({
  comment,
  name,
  parent,
  onReply,
  sourceText,
}: {
  comment: Comment
  name: string
  parent: Comment | null
  onReply: () => void
  sourceText: string
}) {
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
