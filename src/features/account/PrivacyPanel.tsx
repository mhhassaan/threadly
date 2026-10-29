import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountSettings, MemoryItem } from '../../lib/account-thread'
import { getCast } from '../../server/discussion/cast'
import { accountRequest } from './library'
import { useAccountStatus } from './auth-client'

type Confirmation = {
  label: string
  description: string
  input?: { id?: string; personaId?: string }
  account?: boolean
}
export function PrivacyPanel({ owner }: { owner: string }) {
  const client = useQueryClient(),
    account = useAccountStatus()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const cancel = useRef<HTMLButtonElement>(null),
    trigger = useRef<HTMLElement | null>(null)
  const abort = useRef(new AbortController())
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (confirmation) cancel.current?.focus()
  }, [confirmation])
  const settings = useQuery({
    queryKey: ['account', owner, 'settings'],
    retry: false,
    queryFn: ({ signal }) =>
      accountRequest<AccountSettings>(
        '/api/settings',
        'GET',
        undefined,
        signal,
        owner,
      ),
  })
  const memories = useQuery({
    queryKey: ['account', owner, 'memory'],
    retry: false,
    queryFn: ({ signal }) =>
      accountRequest<MemoryItem[]>(
        '/api/memory',
        'GET',
        undefined,
        signal,
        owner,
      ),
  })
  const cast = getCast('20000000-0000-4000-8000-000000000001').filter(
    (p) => p.kind === 'regular',
  )
  function close() {
    setConfirmation(null)
    setPassword('')
    setError('')
    requestAnimationFrame(() => trigger.current?.focus())
  }
  function ask(value: Confirmation) {
    trigger.current = document.activeElement as HTMLElement
    setError('')
    setNotice('')
    setConfirmation(value)
  }
  async function patch(input: {
    aiEnabled?: boolean
    memoryEnabled?: boolean
    acknowledgeConsent?: boolean
  }) {
    setBusy(true)
    setError('')
    try {
      const next = await accountRequest<AccountSettings>(
        '/api/settings',
        'PATCH',
        input,
        abort.current.signal,
        owner,
      )
      if (!abort.current.signal.aborted)
        client.setQueryData(['account', owner, 'settings'], next)
    } catch (e) {
      if (!abort.current.signal.aborted)
        setError(e instanceof Error ? e.message : 'Could not update settings.')
    } finally {
      if (!abort.current.signal.aborted) setBusy(false)
    }
  }
  async function confirm() {
    if (!confirmation || busy) return
    setBusy(true)
    setError('')
    const deletingAccount = !!confirmation.account
    try {
      const credential = password
      setPassword('')
      await accountRequest(
        deletingAccount ? '/api/account' : '/api/memory',
        'DELETE',
        deletingAccount ? { password: credential } : (confirmation.input ?? {}),
        abort.current.signal,
        owner,
      )
      setPassword('')
      if (deletingAccount) {
        account.deleted(owner)
        return
      }
      if (abort.current.signal.aborted) return
      await client.cancelQueries({ queryKey: ['account', owner] })
      client.setQueryData(['account', owner, 'memory'], [])
      void memories.refetch()
      void client.invalidateQueries({ queryKey: ['account', owner] })
      close()
      setNotice(
        'Memory removed. Your saved threads and ordinary history are kept.',
      )
    } catch (e) {
      if (!abort.current.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Could not complete deletion.',
        )
    } finally {
      setPassword('')
      if (!abort.current.signal.aborted) setBusy(false)
    }
  }
  return (
    <section className="privacy-panel" aria-label="Privacy and AI controls">
      <h3>Privacy and AI</h3>
      <p>
        Relevant source text, comments and selected memories are processed by
        DeepSeek. Synced content is stored on Cloudflare. Providers and backups
        may retain copies under their retention policies; deletion here does not
        promise immediate erasure from those systems.
      </p>
      <p>
        Pausing memory stops AI from reading or saving cross-thread memories.
        You can still inspect and remove stored items here. Saved threads and
        ordinary history keep syncing.
      </p>
      {settings.data ? (
        <div className="privacy-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void patch({
                aiEnabled: !settings.data!.aiEnabled,
                ...(!settings.data!.consentAt
                  ? { acknowledgeConsent: true }
                  : {}),
              })
            }
          >
            {settings.data.aiEnabled
              ? 'Pause AI'
              : settings.data.consentAt
                ? 'Enable AI'
                : 'Agree and enable AI'}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void patch({ memoryEnabled: !settings.data!.memoryEnabled })
            }
          >
            {settings.data.memoryEnabled ? 'Pause memory' : 'Enable memory'}
          </button>
        </div>
      ) : (
        <p role="status">
          {settings.error?.message ?? 'Loading privacy settings...'}
        </p>
      )}
      <h4>Stored memories</h4>
      <p>
        Historical human quotes may be incomplete or no longer true. Up to 200
        recent eligible items are shown.
      </p>
      {memories.isPending ? (
        <p role="status">Loading memories...</p>
      ) : memories.error ? (
        <p role="alert">
          {memories.error.message}{' '}
          <button
            className="text-button"
            onClick={() => void memories.refetch()}
          >
            Retry memories
          </button>
        </p>
      ) : !memories.data?.length ? (
        <p>No stored memories.</p>
      ) : (
        <ul className="privacy-memories">
          {memories.data.map((m) => (
            <li key={m.id}>
              <strong>
                {cast.find((p) => p.id === m.personaId)?.name ?? 'Regular'}
              </strong>
              <blockquote>{m.text}</blockquote>
              {m.evidence.map((e) => (
                <a
                  key={e.id}
                  href={
                    '/?thread=' +
                    encodeURIComponent(e.threadId) +
                    '#post-' +
                    e.postId
                  }
                >
                  View supporting conversation
                </a>
              ))}{' '}
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  ask({
                    label: 'Delete memory',
                    description:
                      'Remove this item and prevent this regular from saving it again from the same old comment.',
                    input: { id: m.id },
                  })
                }
              >
                Delete memory
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="privacy-actions">
        {cast.map((p) => (
          <button
            key={p.id}
            className="text-button"
            disabled={busy}
            onClick={() =>
              ask({
                label: 'Reset ' + p.name + "'s memory",
                description:
                  "Remove this regular's memories. Earlier conversations cannot recreate them. Other regulars' memories and your saved threads are kept.",
                input: { personaId: p.id },
              })
            }
          >
            Reset {p.name}'s memory
          </button>
        ))}
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            ask({
              label: 'Clear all AI memory',
              description:
                "Remove all regulars' memories. Earlier conversations cannot recreate them. Your saved threads and discussions are kept.",
            })
          }
        >
          Clear all AI memory
        </button>
        <button
          className="account-discard"
          disabled={busy}
          onClick={() =>
            ask({
              label: 'Delete account',
              description:
                'Permanently delete your account, saved account threads, discussions, memory and sessions. Guest threads on this device are kept. Enter your current password to confirm.',
              account: true,
            })
          }
        >
          Delete account
        </button>
      </div>
      {confirmation && (
        <section className="privacy-confirm" aria-label={confirmation.label}>
          <h4>{confirmation.label}?</h4>
          <p>{confirmation.description}</p>
          {confirmation.account && (
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={128}
              />
            </label>
          )}
          <div className="privacy-actions">
            <button
              ref={cancel}
              className="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="account-discard"
              disabled={busy || (confirmation.account && !password)}
              onClick={() => void confirm()}
            >
              {busy ? 'Working...' : confirmation.label}
            </button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
