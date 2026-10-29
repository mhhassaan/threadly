import type { ThreadRecord } from '../lib/thread'
import {
  useReplyComposer,
  type ReplySubmit,
} from '../features/account/reply-composer'

export function Replies({
  record,
  index,
  onReply,
  storageKey,
}: {
  record: ThreadRecord
  index: number
  onReply: ReplySubmit
  storageKey?: string
}) {
  const { value, sending, change, submit } = useReplyComposer(
    onReply,
    storageKey,
  )
  return (
    <>
      <p className="dialog-description">
        {storageKey
          ? 'Replies are saved privately in your account. Unsent drafts stay in this tab until you retry.'
          : 'A space for your thoughts. Replies are saved on this device and are not published to Twitter/X.'}
      </p>
      <blockquote className="reply-quote">{record.posts[index]}</blockquote>
      <div className="local-replies">
        {record.interactions[index]?.replies?.map((r, i) => (
          <article key={i}>
            <strong>You</strong>
            <p>{r.text}</p>
          </article>
        ))}
      </div>
      <form
        className="reply-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="replyText">Add a reply</label>
        <textarea
          id="replyText"
          maxLength={2000}
          disabled={sending}
          placeholder="What does this idea make you think of?"
          required
          data-autofocus
          value={value}
          onChange={(e) => change(e.target.value)}
        />
        <button
          className="copy-primary"
          type="submit"
          disabled={!value.trim() || sending}
        >
          Add reply
        </button>
      </form>
    </>
  )
}
