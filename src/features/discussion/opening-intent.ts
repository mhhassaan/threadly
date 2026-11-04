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
    !snapshot.openingBlocked &&
    !!settings?.aiEnabled &&
    !!settings.consentAt
  )
}
