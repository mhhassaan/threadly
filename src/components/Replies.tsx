import { readerFocusUrl } from '../features/reader/ReaderNavigation'
import type { ThreadRecord } from '../lib/thread'
import { ThreadReplyComposer } from './Post'
import { PostFrame, PostActions } from './PostChrome'
import type { ReplySubmit } from '../features/account/reply-composer'
export function Replies({
  record,
  index,
  onReply,
  storageKey,
  onOpen,
}: {
  record: ThreadRecord
  index: number
  onReply: ReplySubmit
  storageKey?: string
  onOpen?: (reply: number) => void
}) {
  return (
    <section aria-label="Replies" className="focused-conversation">
      <ThreadReplyComposer
        inputId={'local-reply-' + index}
        storageKey={storageKey}
        onReply={onReply}
      />
      {record.interactions[index]?.replies?.map((r, i) => (
        <PostFrame
          key={i}
          name="You"
          handle="@you"
          id={'local-comment-' + i}
          onOpen={() => onOpen?.(i)}
          meta={
            r.date ? (
              <time dateTime={r.date}>
                {new Date(r.date).toLocaleDateString()}
              </time>
            ) : undefined
          }
        >
          <div className="posttext">{r.text}</div>
          <PostActions
            state={{}}
            onReply={() =>
              document.getElementById('local-reply-' + index)?.focus()
            }
            onShare={() => {
              void navigator.clipboard
                .writeText(
                  location.origin +
                    readerFocusUrl(location.href, {
                      postId: String(index),
                      commentId: String(i),
                    }),
                )
                .catch(() => {})
            }}
          />
        </PostFrame>
      ))}
    </section>
  )
}
