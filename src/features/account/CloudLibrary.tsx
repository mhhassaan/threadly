import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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
  const [error, setError] = useState('')
  async function remove(id: string) {
    try {
      await accountRequest('/api/threads/' + id, 'DELETE', {}, undefined, owner)
      client.removeQueries({ queryKey: accountThreadKey(owner, id) })
      void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not delete this thread.',
      )
    }
  }
  return (
    <>
      <h3>Private account library</h3>
      <p>Saved threads sync across your signed-in devices.</p>
      {library.isPending && <p role="status">Loading your library…</p>}
      {library.error && (
        <p role="status">
          Connection unavailable. Cached threads remain readable.{' '}
          <button onClick={() => void library.refetch()}>Retry library</button>
        </p>
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
              onClick={() => void remove(thread.id)}
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
