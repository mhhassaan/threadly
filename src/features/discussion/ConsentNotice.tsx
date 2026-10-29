import { useContext, useEffect, useRef, useState } from 'react'
import { DiscussionContext } from './useDiscussion'
import { useCloudThread } from '../account/library'
import type { AccountSettings, ThreadSnapshot } from '../../lib/account-thread'
import { draftKey } from '../account/auth-state'
export const openingIntentKey = (owner: string, threadId: string) =>
  draftKey(owner, 'new-opening:' + threadId)
export function moveOpeningIntent(
  source: Pick<Storage, 'getItem' | 'removeItem'>,
  target: Pick<Storage, 'setItem'>,
  key: string,
) {
  const intent = source.getItem(key)
  source.removeItem(key)
  if (intent === 'new') target.setItem(key, intent)
}
export function shouldOpenDiscussion(
  intent: boolean,
  snapshot: ThreadSnapshot | undefined,
  settings: AccountSettings | undefined,
) {
  return (
    intent &&
    snapshot?.isImported === false &&
    !!settings?.aiEnabled &&
    !!settings.consentAt
  )
}
export function ConsentNotice({ threadId }: { threadId: string }) {
  const discussion = useContext(DiscussionContext)!
  const snapshot = useCloudThread(discussion.owner, threadId).data
  const [details, setDetails] = useState(false)
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
  const settings = discussion.settings
  return (
    <div className="discussion-notice">
      <div className="discussion-toolbar">
        <span>Private discussion</span>
        <button
          className="text-button"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          AI settings
        </button>
      </div>
      {(!settings?.consentAt || details) && (
        <div className="discussion-consent">
          <p>
            AI participants are fictional. Relevant source text, comments and
            selected remembered context are processed by DeepSeek. Your synced
            threads and discussions are stored on Cloudflare and are private to
            your account.
          </p>
          <p>
            AI and memory are off by default. Cross-thread memory and privacy
            controls are still being built; this version does not save AI
            memories.
          </p>
          {!settings?.consentAt ? (
            <button
              className="secondary"
              disabled={!settings || discussion.settingsBusy}
              onClick={() =>
                void discussion.updateSettings({
                  aiEnabled: true,
                  acknowledgeConsent: true,
                })
              }
            >
              Agree and enable AI
            </button>
          ) : (
            <button
              className="secondary"
              disabled={discussion.settingsBusy}
              onClick={() =>
                void discussion.updateSettings({
                  aiEnabled: !settings.aiEnabled,
                })
              }
            >
              {settings.aiEnabled ? 'Pause AI' : 'Enable AI'}
            </button>
          )}
          {settings?.memoryEnabled && (
            <button
              className="text-button"
              disabled={discussion.settingsBusy}
              onClick={() =>
                void discussion.updateSettings({ memoryEnabled: false })
              }
            >
              Pause memory
            </button>
          )}
        </div>
      )}
      {snapshot && !snapshot.thread.record.sourceText?.trim() && (
        <p>
          Original source text is unavailable. AI can discuss the saved posts,
          but cannot verify them against the source.
        </p>
      )}
      {settings?.consentAt && (
        <div className="discussion-controls">
          <span>{settings.aiEnabled ? 'AI enabled' : 'AI paused'}</span>
          <button
            className="text-button"
            disabled={
              !settings.aiEnabled ||
              discussion.pending ||
              discussion.settingsBusy
            }
            onClick={() =>
              void discussion.generate({
                requestId: crypto.randomUUID(),
                threadId,
                kind: 'opening',
                triggerCommentId: null,
              })
            }
          >
            Start discussion
          </button>
        </div>
      )}
      {discussion.pending && (
        <div role="status" className="discussion-controls">
          <span>Generating AI replies…</span>
          <button
            className="text-button"
            disabled={discussion.cancelling}
            onClick={() => void discussion.cancel(discussion.turn?.id)}
          >
            {discussion.cancelling
              ? 'Confirming cancellation…'
              : 'Cancel generation'}
          </button>
        </div>
      )}
      {(discussion.error || discussion.settingsError) && (
        <div role="status" className="discussion-error">
          <p>{discussion.error || discussion.settingsError}</p>
          {discussion.input &&
            !discussion.pending &&
            !['cancelled', 'complete'].includes(
              discussion.turn?.status ?? '',
            ) && (
              <button
                className="text-button"
                disabled={!settings?.aiEnabled}
                onClick={() =>
                  void discussion.retry(discussion.input!.requestId)
                }
              >
                Retry AI replies
              </button>
            )}
        </div>
      )}
    </div>
  )
}
