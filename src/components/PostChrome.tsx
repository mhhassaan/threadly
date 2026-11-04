import type { ReactNode } from 'react'
import { useState } from 'react'
import { shouldOpenPost } from '../features/reader/ReaderNavigation'
import { mediaUrl } from '../lib/thread'
const paths: Record<string, string> = {
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  back: 'M19 12H5m7-7-7 7 7 7',
  reply: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2.3-3.1A8.5 8.5 0 1 1 21 11.5Z',
  retweet:
    'm4 8 3-3 3 3M7 5v11a2 2 0 0 0 2 2h4m7-2-3 3-3-3m3 3V8a2 2 0 0 0-2-2h-4',
  like: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  share: 'M12 16V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  copy: 'M9 9h12v12H9zM15 5V3H3v12h2',
  image: 'M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M8 7h.01',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  user: 'M20 21v-2a8 8 0 0 0-16 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
}
export function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}

export function PostMenu({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <details
      className="post-more"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.open = false
          e.currentTarget.querySelector('summary')?.focus()
        }
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) {
          e.currentTarget.open = false
          e.currentTarget.querySelector('summary')?.focus()
        }
      }}
    >
      <summary aria-label={label}>
        <Icon name="more" />
      </summary>
      <div className="post-menu">{children}</div>
    </details>
  )
}
export function PostFrame({
  name,
  handle,
  image,
  meta,
  ai,
  first,
  selected,
  postId,
  id,
  onOpen,
  children,
  menu,
  selection,
}: {
  name: string
  handle: string
  image?: string
  meta?: ReactNode
  ai?: boolean
  first?: boolean
  selected?: boolean
  postId?: string
  id?: string
  onOpen?: () => void
  children: ReactNode
  menu?: ReactNode
  selection?: ReactNode
}) {
  const [failed, setFailed] = useState(false),
    icon = mediaUrl(image)
  return (
    <article
      className={
        'post' + (first ? ' first-post' : '') + (selected ? ' is-selected' : '')
      }
      id={id}
      data-post-id={postId}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={'Post by ' + name}
      onClick={(e) => {
        if (
          onOpen &&
          shouldOpenPost(
            e.target as HTMLElement,
            window.getSelection()?.toString() ?? '',
          )
        )
          onOpen()
      }}
      onKeyDown={(e) => {
        if (onOpen && e.target === e.currentTarget && e.key === 'Enter') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        className={'avatar' + (icon && !failed ? ' has-source-image' : '')}
        aria-label={name + ' profile picture'}
      >
        <Icon name="user" />
        {icon && !failed && (
          <img
            src={icon}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <div className="post-body">
        <div className="author">
          <div className="author-identity">
            <strong className="source-name">{name}</strong>
            {ai && <span className="ai-label">AI</span>}
            <span className="handle">{handle}</span>
          </div>
          {meta && <span className="tweet-time">{meta}</span>}
          {selection}
          {menu}
        </div>
        {children}
      </div>
    </article>
  )
}
export type ActionState = {
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
}
export function PostActions({
  state,
  replies,
  onReply,
  onReact,
  onShare,
  busy,
}: {
  state: ActionState
  replies?: number
  onReply: () => void
  onReact?: (key: 'liked' | 'reposted' | 'bookmarked') => void
  onShare: () => void
  busy?: boolean
}) {
  return (
    <div className="post-actions">
      <button aria-label="Reply to post" onClick={onReply}>
        <Icon name="reply" />
        <span className="action-count">{replies || ''}</span>
      </button>
      {onReact && (
        <>
          <button
            disabled={busy}
            aria-label={state.reposted ? 'Undo repost' : 'Repost privately'}
            aria-pressed={!!state.reposted}
            onClick={() => onReact('reposted')}
          >
            <Icon name="retweet" />
          </button>
          <button
            disabled={busy}
            aria-label={state.liked ? 'Unlike post' : 'Like post'}
            aria-pressed={!!state.liked}
            onClick={() => onReact('liked')}
          >
            <Icon name="like" />
          </button>
          <button
            disabled={busy}
            aria-label={state.bookmarked ? 'Remove bookmark' : 'Bookmark post'}
            aria-pressed={!!state.bookmarked}
            onClick={() => onReact('bookmarked')}
          >
            <Icon name="bookmark" />
          </button>
        </>
      )}
      <button aria-label="Copy link to post" onClick={onShare}>
        <Icon name="share" />
      </button>
    </div>
  )
}
