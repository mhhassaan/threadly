import { useContext, useEffect, useRef } from 'react'
import { DiscussionContext } from './useDiscussion'
import { useCloudThread } from '../account/library'
import { openingIntentKey, shouldOpenDiscussion } from './opening-intent'
export function AutomaticDiscussion({ threadId }: { threadId: string }) {
  const discussion = useContext(DiscussionContext)!
  const snapshot = useCloudThread(discussion.owner, threadId).data
  const consumed = useRef(false),
    intent = useRef<boolean | null>(null)
  useEffect(() => {
    if (intent.current === null) {
      intent.current = false
      try {
        intent.current =
          sessionStorage.getItem(
            openingIntentKey(discussion.owner, threadId),
          ) === 'new'
        sessionStorage.removeItem(openingIntentKey(discussion.owner, threadId))
      } catch {}
    }
    if (
      consumed.current ||
      !shouldOpenDiscussion(intent.current, snapshot, discussion.settings)
    )
      return
    consumed.current = true
    void discussion.generate({
      requestId: crypto.randomUUID(),
      threadId,
      kind: 'opening',
      triggerCommentId: null,
    })
  }, [snapshot, discussion.settings])
  return null
}
