import { draftKey } from './auth-state'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ThreadRecord } from '../../lib/thread'
import { ImportLocalThreads } from './ImportLocalThreads'
import {
  accountLibraryKey,
  accountRequest,
  accountThreadKey,
  useCloudLibrary,
} from './library'

export function CloudLibrary({
  owner,
  local,
}: {
  owner: string
  local: ThreadRecord[]
}) {
  const library = useCloudLibrary(owner),
    client = useQueryClient()
  const [error, setError] = useState(''),
    [deleting, setDeleting] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const cancel = useRef<HTMLButtonElement>(null),
    trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (deleting) cancel.current?.focus()
  }, [deleting])
  async function remove(id: string) {
    setBusy(true)
    setError('')
    try {
      await accountRequest('/api/threads/' + id, 'DELETE', {}, undefined, owner)
      await client.cancelQueries({ queryKey: accountThreadKey(owner, id) })
      client.removeQueries({ queryKey: accountThreadKey(owner, id) })
      try {
        const prefix = draftKey(owner, 'comment:' + id + ':')
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i)
          if (key?.startsWith(prefix)) sessionStorage.removeItem(key)
        }
        sessionStorage.removeItem(draftKey(owner, 'new-opening:' + id))
      } catch {}
      void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
      setDeleting(null)
      requestAnimationFrame(() => heading.current?.focus())
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not delete this thread.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h3 ref={heading} tabIndex={-1}>
        Private account library
      </h3>
      <p>Saved threads sync across your signed-in devices.</p>
      {library.isPending && <p role="status">Loading your library…</p>}
      {library.error && (
        <p role="status">
          Connection unavailable. Cached threads remain readable.{' '}
          <button onClick={() => void library.refetch()}>Retry library</button>
        </p>
      )}
      {deleting && (
        <section className="privacy-confirm" aria-label="Delete saved thread">
          <h4>Delete saved account thread?</h4>
          <p>
            This permanently removes its source, posts, discussion, reading
            progress and supported memories. Device guest copies are kept.
          </p>
          <div className="privacy-actions">
            <button
              ref={cancel}
              className="secondary"
              disabled={busy}
              onClick={() => {
                setDeleting(null)
                setError('')
                requestAnimationFrame(() => trigger.current?.focus())
              }}
            >
              Cancel
            </button>
            <button
              className="account-discard"
              disabled={busy}
              onClick={() => void remove(deleting)}
            >
              {busy ? 'Deleting...' : 'Delete saved thread'}
            </button>
          </div>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {library.data?.pages
        .flatMap((page) => page.threads)
        .map((thread) => (
          <div className="saved-item" key={thread.id}>
            <a
              className="saved-open"
              href={'/?thread=' + encodeURIComponent(thread.id)}
            >
              {thread.record.title}
              <small>{thread.posts.length} posts · private</small>
            </a>
            <button
              className="delete-saved"
              aria-label={'Delete account thread ' + thread.record.title}
              onClick={(e) => {
                trigger.current = e.currentTarget
                setDeleting(thread.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      {library.data?.pages[0].threads.length === 0 && (
        <p>
          No account threads yet. Create a new thread or import your device
          copies.
        </p>
      )}
      {library.hasNextPage && (
        <button
          className="secondary"
          disabled={library.isFetchingNextPage}
          onClick={() => void library.fetchNextPage()}
        >
          Load more threads
        </button>
      )}
      <ImportLocalThreads owner={owner} records={local} />
      {!!local.length && <h3>Device copies</h3>}
    </>
  )
}
