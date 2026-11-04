import { useEffect, useRef, useState } from 'react'
import { mediaUrl, remoteUrl } from '../lib/thread'
import type { Media, ThreadRecord, Reaction } from '../lib/thread'
import { useReplyComposer } from '../features/account/reply-composer'
import { Icon, PostFrame, PostMenu, PostActions } from './PostChrome'
export { Icon } from './PostChrome'
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
  onOpen,
  postId,
  replyCount,
  reactionBusy,
  prominent,
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
  onOpen?: (i: number) => void
  prominent?: boolean
  postId?: string
  replyCount?: number
  reactionBusy?: boolean
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(record.posts[index])
  const text = record.posts[index],
    state: Reaction = record.interactions[index] || { replies: [] }
  const media = record.media.filter((m) => m.postIndex === index),
    editor = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) editor.current?.focus()
  }, [editing])
  return (
    <PostFrame
      name={record.source?.name || 'You'}
      handle={record.source?.handle ? '@' + record.source.handle : '@you'}
      image={record.source?.icon}
      first={prominent || index === 0}
      selected={selected}
      postId={postId ?? String(index)}
      id={'reader-post-' + index}
      onOpen={
        !editing && !selectionMode && onOpen ? () => onOpen(index) : undefined
      }
      selection={
        <label className="post-select" hidden={!selectionMode}>
          <input
            type="checkbox"
            aria-label={'Select tweet ' + (index + 1)}
            checked={selected}
            onChange={() => onSelect(index)}
          />
          <span className="sr-only">Select tweet</span>
        </label>
      }
      menu={
        <PostMenu label={'More options for post ' + (index + 1)}>
          <button
            onClick={() => {
              setDraft(text)
              setEditing(true)
            }}
          >
            Edit post
          </button>
          <button onClick={() => onCopy(index)}>Copy post</button>
          <button onClick={() => onExport(index)}>Save as image</button>
          {remoteUrl(record.sourceUrl) && (
            <a
              href={remoteUrl(record.sourceUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Original source
            </a>
          )}
        </PostMenu>
      }
    >
      {editing ? (
        <div className="post-editor" data-no-open>
          <textarea
            ref={editor}
            aria-label={'Edit post ' + (index + 1)}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            onClick={() => {
              onEdit(index, draft)
              setEditing(false)
            }}
          >
            Save
          </button>
          <button
            onClick={() => {
              setDraft(text)
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="posttext">{text}</div>
      )}
      {media.length > 0 && (
        <div className="article-media">
          {media.map((m, i) => (
            <Attachment key={m.url + i} item={m} onImage={onImage} />
          ))}
        </div>
      )}
      {index === 0 && (record.date || remoteUrl(record.sourceUrl)) && (
        <div className="tweet-meta">
          {record.date && <span>{record.date}</span>}
          {remoteUrl(record.sourceUrl) && (
            <a
              href={remoteUrl(record.sourceUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Source
            </a>
          )}
        </div>
      )}
      <PostActions
        state={state}
        replies={replyCount ?? state.replies?.length}
        onReply={() => onReply(index)}
        onReact={(key) => onReact(index, key)}
        onShare={() => onShare(index)}
        busy={reactionBusy}
      />
    </PostFrame>
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
