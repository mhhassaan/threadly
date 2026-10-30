import { ThreadManagement } from './ThreadManagement'
import { PrivacyPanel } from './PrivacyPanel'
import { UsageStatus } from './UsageStatus'
import { useState } from 'react'
import { AuthForms } from './AuthForms'
import { useAccountStatus } from './auth-client'

export function AccountPanel({
  token,
  verified = false,
  linkError = false,
}: {
  token?: string
  verified?: boolean
  linkError?: boolean
}) {
  const { user, pending, unavailable, expired, retry, signOut } =
    useAccountStatus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function logout() {
    setBusy(true)
    setError('')
    try {
      await signOut()
    } catch {
      setError(
        'Could not sign out on the server. Check your connection and try again. Local account drafts have been cleared.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="account-panel">
      <p className="dialog-description">
        Your guest threads stay on this device. Account access is separate from
        your guest reading list.
      </p>
      {pending ? (
        <p role="status">Checking your account…</p>
      ) : (
        <>
          {unavailable && (
            <div className="account-notice" role="alert">
              <p>
                We could not check your session. Your current draft is kept for
                this account.
              </p>
              <button className="secondary" onClick={() => void retry()}>
                Retry session check
              </button>
            </div>
          )}
          {expired && !unavailable && (
            <p className="account-notice" role="status">
              Your session ended. Sign in again with the same account to
              continue your draft.
            </p>
          )}
          {user && !token ? (
            <>
              <h3>Hi, {user.name}</h3>
              <p>
                {user.verified
                  ? 'Your email is verified.'
                  : 'Your email still needs verification.'}
              </p>
              {!user.verified && <AuthForms initialMode="verify" />}
              <p className="account-hint">
                {user.verified
                  ? 'Your private saved threads sync across devices. Import device copies from Saved threads when you choose. Private discussions stay with their threads.'
                  : 'Verify your email to use your private account library. You can keep creating and reading guest threads now.'}
              </p>
              {user.verified && (
                <UsageStatus key={'usage-' + user.id} owner={user.id} />
              )}
              {user.verified && <PrivacyPanel key={user.id} owner={user.id} />}
              {user.verified && (
                <ThreadManagement key={'threads-' + user.id} owner={user.id} />
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void logout()}
              >
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          ) : (
            <AuthForms
              initialMode={
                token
                  ? 'reset'
                  : linkError
                    ? verified
                      ? 'verify'
                      : 'forgot'
                    : 'login'
              }
              token={token}
              initialNotice={
                linkError
                  ? 'This link is invalid or expired. Request a new link below.'
                  : verified
                    ? 'Your email is verified. Sign in to continue.'
                    : ''
              }
            />
          )}
          {(expired || unavailable) && !user && (
            <button
              className="account-discard"
              disabled={busy}
              onClick={() => void logout()}
            >
              Sign out and clear account drafts
            </button>
          )}
        </>
      )}
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
