import { ThreadManagement } from './ThreadManagement'
import { PrivacyPanel } from './PrivacyPanel'
import { UsageStatus } from './UsageStatus'
import { useState } from 'react'
import { AuthForms } from './AuthForms'
import { useAccountStatus } from './auth-client'
import { useQuery } from '@tanstack/react-query'
import { getGenerationQuota } from '../generation/client'

export function AccountPanel({
  token,
  verified = false,
  linkError = false,
}: {
  token?: string
  verified?: boolean
  linkError?: boolean
}) {
  const {
    user,
    pending,
    unavailable,
    expired,
    retry,
    signOut,
    generationClaimPending,
    generationClaimError,
    retryGenerationClaim,
  } = useAccountStatus()
  const allowance = useQuery({
    queryKey: ['account', user?.id, 'generation-quota'],
    queryFn: ({ signal }) => getGenerationQuota(user!.id, signal),
    enabled:
      !!user?.verified &&
      !pending &&
      !unavailable &&
      !expired &&
      !generationClaimPending &&
      !generationClaimError,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  })
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
      {pending && <p role="status">Checking your account…</p>}
      <div hidden={pending}>
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
            Your session ended. Sign in again with the same account to continue
            your draft.
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
                : 'Verify your email to create threads and use your private account library. Your existing device threads stay readable.'}
            </p>
            {user.verified && (
              <div className="account-notice" role="status">
                {generationClaimPending ? (
                  'Carrying over completed guest usage…'
                ) : generationClaimError ? (
                  <>
                    {generationClaimError}
                    <button
                      className="secondary"
                      onClick={retryGenerationClaim}
                    >
                      Retry allowance check
                    </button>
                  </>
                ) : allowance.isFetching ? (
                  'Checking your thread allowance…'
                ) : allowance.data ? (
                  `${allowance.data.remaining} of 10 threads remaining today. Resets at midnight UTC. Completed guest usage carries over once on first verified sign-in.`
                ) : (
                  'Thread allowance unavailable. Check your connection and try again.'
                )}
              </div>
            )}
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
      </div>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
