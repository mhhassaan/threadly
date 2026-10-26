import { useEffect, useRef, useState } from 'react'
import { mediaUrl, remoteUrl } from '../lib/thread'
import type { Media, ThreadRecord, Reaction } from '../lib/thread'
const paths: Record<string, string> = {
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
  const text = record.posts[index]
  const state: Reaction = record.interactions[index] || { replies: [] }
  const name = record.source?.name || 'You'
  const handle = record.source?.handle ? '@' + record.source.handle : '@you'
  const icon = mediaUrl(record.source?.icon)
  const n = Array.from(
    text + ' ' + (index + 1) + '/' + record.posts.length,
  ).length
  const media = record.media.filter((m) => m.postIndex === index)
  const editable = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editable.current && editable.current.innerText !== text)
      editable.current.innerText = text
  }, [text])
  return (
    <article
      className={
        'post' +
        (index === 0 ? ' first-post' : '') +
        (selected ? ' is-selected' : '')
      }
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
          ↻ Reposted by you · local
        </div>
        <div className="author">
          <strong className="source-name">{name}</strong>
          <span className="handle">{handle}</span>
          <span className="tweet-time">· now</span>
          <label className="post-select">
            <input
              type="checkbox"
              aria-label={'Select tweet ' + (index + 1)}
              checked={selected}
              onChange={() => onSelect(index)}
            />
            <span className="sr-only">Select tweet</span>
          </label>
        </div>
        {index > 0 && (
          <div className="replying">
            Replying to <span>{handle}</span>
          </div>
        )}
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
          <span className="postnum">
            {index + 1}/{record.posts.length}
          </span>
          <span
            className="chars"
            title={
              n > 280
                ? 'Kept together to preserve a complete sentence. Edit if you need a shorter tweet.'
                : undefined
            }
          >
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
          <button aria-label="Copy this tweet" onClick={() => onCopy(index)}>
            <Icon name="copy" />
          </button>
          <button aria-label="Share this tweet" onClick={() => onShare(index)}>
            <Icon name="share" />
          </button>
          <button
            className="image-post"
            aria-label="Save tweet as image"
            onClick={() => onExport(index)}
          >
            <Icon name="image" />
          </button>
        </div>
      </div>
    </article>
  )
}
