import { useEffect, useRef, useState } from 'react'
import { mediaUrl, remoteUrl } from '../lib/thread'
import type { Media, ThreadRecord, Reaction } from '../lib/thread'
import { useReplyComposer } from '../features/account/reply-composer'
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
export function Attachment({
  item,
  onImage,
}: {
  item: Media
  onImage: (m: Media) => void
}) {
  const [failed, setFailed] = useState(false)
  const url = remoteUrl(item.url)
  if (!url) return null
  const fallback = (
    <a
      className="media-fallback"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open media at the source ↗
    </a>
  )
  return (
    <figure className="article-attachment">
      {failed ? (
        fallback
      ) : item.type === 'image' ? (
        <button
          className="media-image-button"
          aria-label={'Enlarge image: ' + (item.alt || 'Article image')}
          onClick={() => onImage(item)}
        >
          <img
            src={mediaUrl(url)}
            alt={item.alt || 'Image from the article'}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        </button>
      ) : item.type === 'video' ? (
        <video
          src={url}
          poster={mediaUrl(item.poster) || undefined}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          aria-label={item.caption || 'Media from the article'}
        />
      ) : item.type === 'audio' ? (
        <audio
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          aria-label={item.caption || 'Media from the article'}
        />
      ) : item.type === 'embed' &&
        /^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}$/.test(url) ? (
        <iframe
          src={url}
          title={item.title || 'Video from the article'}
          loading="lazy"
          allow="encrypted-media; fullscreen; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      ) : (
        fallback
      )}
      {item.caption && <figcaption>{item.caption}</figcaption>}
    </figure>
  )
}
export function Post({
  record,
  index,
  selected,
  selectionMode,
  onSelect,
  onEdit,
  onReact,
  onReply,
  onCopy,
  onShare,
  onExport,
  onImage,
}: {
  record: ThreadRecord
  index: number
  selected: boolean
  selectionMode: boolean
  onSelect: (i: number) => void
  onEdit: (i: number, text: string) => void
  onReact: (i: number, key: 'liked' | 'reposted' | 'bookmarked') => void
  onReply: (i: number) => void
  onCopy: (i: number) => void
  onShare: (i: number) => void
  onExport: (i: number) => void
  onImage: (m: Media) => void
}) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  const text = record.posts[index],
    state: Reaction = record.interactions[index] || { replies: [] }
  const name = record.source?.name || 'You',
    handle = record.source?.handle ? '@' + record.source.handle : '@you'
  const icon = mediaUrl(record.source?.icon),
    first = index === 0
  const n = Array.from(
    text + ' ' + (index + 1) + '/' + record.posts.length,
  ).length
  const media = record.media.filter((m) => m.postIndex === index)
  const editable = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editable.current && editable.current.innerText !== text)
      editable.current.innerText = text
  }, [text])
  function menuAction(
    event: React.MouseEvent<HTMLElement>,
    action: () => void,
  ) {
    event.currentTarget.closest('details')?.removeAttribute('open')
    action()
  }
  return (
    <article
      className={
        'post' + (first ? ' first-post' : '') + (selected ? ' is-selected' : '')
      }
      aria-label={'Post ' + (index + 1) + ' of ' + record.posts.length}
    >
      <div
        className={
          'avatar' + (icon && !avatarFailed ? ' has-source-image' : '')
        }
        aria-label={name + ' profile picture'}
      >
        <Icon name="user" />
        {icon && !avatarFailed && (
          <img
            src={icon}
            alt={name}
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
          />
        )}
      </div>
      <div className="post-body">
        <div className="repost-label" hidden={!state.reposted}>
          Reposted by you · local
        </div>
        <div className="author">
          <div className="author-identity">
            <strong className="source-name">{name}</strong>
            <span className="handle">{handle}</span>
          </div>
          {!first && (
            <span className="tweet-time">
              · {index + 1}/{record.posts.length}
            </span>
          )}
          <label className="post-select" hidden={!selectionMode}>
            <input
              type="checkbox"
              aria-label={'Select tweet ' + (index + 1)}
              checked={selected}
              onChange={() => onSelect(index)}
            />
            <span className="sr-only">Select tweet</span>
          </label>
          <details className="post-more">
            <summary aria-label={'More options for post ' + (index + 1)}>
              <Icon name="more" />
            </summary>
            <div className="post-menu">
              <button onClick={(e) => menuAction(e, () => onCopy(index))}>
                <Icon name="copy" />
                Copy post
              </button>
              <button onClick={(e) => menuAction(e, () => onExport(index))}>
                <Icon name="image" />
                Save as image
              </button>
              <span>{n} characters</span>
            </div>
          </details>
        </div>
        <div
          ref={editable}
          className="posttext"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          spellCheck={false}
          aria-label={'Edit post ' + (index + 1)}
          onInput={(e) => onEdit(index, e.currentTarget.innerText)}
        />
        {media.length > 0 && (
          <div className="article-media">
            {media.map((m, i) => (
              <Attachment key={m.url + i} item={m} onImage={onImage} />
            ))}
          </div>
        )}
        <div className="tweet-meta">
          {first && (
            <>
              <span>{record.date || 'Reading thread'}</span>
              <span aria-hidden="true"> · </span>
              <span>{record.posts.length} posts</span>
              {remoteUrl(record.sourceUrl) && (
                <>
                  <span aria-hidden="true"> · </span>
                  <a
                    href={remoteUrl(record.sourceUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source
                  </a>
                </>
              )}
            </>
          )}
          <span className="chars">
            {n > 280 ? n + ' characters · complete thought' : n + '/280'}
          </span>
        </div>
        <div className="post-actions">
          <button
            className="reply-post"
            aria-label="Reply to tweet"
            onClick={() => onReply(index)}
          >
            <Icon name="reply" />
            <span className="action-count">{state.replies?.length || ''}</span>
          </button>
          <button
            className="repost-post"
            aria-label={
              state.reposted ? 'Undo local repost' : 'Repost tweet locally'
            }
            aria-pressed={!!state.reposted}
            onClick={() => onReact(index, 'reposted')}
          >
            <Icon name="retweet" />
            <span className="action-count">{state.reposted ? '1' : ''}</span>
          </button>
          <button
            className="like-post"
            aria-label={state.liked ? 'Unlike tweet' : 'Like tweet'}
            aria-pressed={!!state.liked}
            onClick={() => onReact(index, 'liked')}
          >
            <Icon name="like" />
            <span className="action-count">{state.liked ? '1' : ''}</span>
          </button>
          <button
            className="bookmark-post"
            aria-label={
              state.bookmarked ? 'Remove tweet bookmark' : 'Bookmark tweet'
            }
            aria-pressed={!!state.bookmarked}
            onClick={() => onReact(index, 'bookmarked')}
          >
            <Icon name="bookmark" />
          </button>
          <button aria-label="Share this tweet" onClick={() => onShare(index)}>
            <Icon name="share" />
          </button>
        </div>
      </div>
    </article>
  )
}
export function ThreadReplyComposer({
  onReply,
  storageKey,
  privateReply,
  inputId = 'threadReply',
}: {
  onReply: (text: string) => void | Promise<boolean>
  storageKey?: string
  inputId?: string
  privateReply?: boolean
}) {
  const { value, sending, change, submit } = useReplyComposer(
    onReply,
    storageKey,
  )
  return (
    <form
      className="thread-reply-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="avatar" aria-label="Your profile picture">
        <Icon name="user" />
      </div>
      <label className="sr-only" htmlFor={inputId}>
        Post your reply
      </label>
      <textarea
        id={inputId}
        placeholder="Post your reply"
        aria-describedby={inputId + '-hint'}
        maxLength={2000}
        disabled={sending}
        rows={1}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
      <button type="submit" disabled={!value.trim() || sending}>
        Reply
      </button>
      <span id={inputId + '-hint'} className="sr-only">
        {privateReply
          ? 'Replies are saved privately in your account. Failed replies stay editable until you retry.'
          : 'Replies are saved on this device and are not posted to X.'}
      </span>
    </form>
  )
}
