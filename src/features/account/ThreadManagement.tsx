import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCloudLibrary, useCloudThread, accountThreadKey } from './library'
import { DeleteConversation } from '../discussion/DeleteConversation'
import { useThreadDiscussion } from '../discussion/useDiscussion'

export function ThreadManagement({ owner }: { owner: string }) {
  const library = useCloudLibrary(owner)
  const [threadId, setThreadId] = useState('')
  const threads = library.data?.pages.flatMap((page) => page.threads) ?? []
  return (
    <section className="privacy-panel" aria-label="Conversation management">
      <h3>Conversation management</h3>
      <p>
        Choose a saved thread and post to manage its conversation. Source posts
        and other conversations stay saved.
      </p>
      <label className="account-field">
        <span>Saved thread</span>
        <select
          value={threadId}
          onChange={(event) => setThreadId(event.target.value)}
        >
          <option value="">Choose a thread</option>
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.record.title}
            </option>
          ))}
        </select>
      </label>
      {library.isPending && <p role="status">Loading saved threads…</p>}
      {library.error && <p role="alert">{library.error.message}</p>}
      {library.hasNextPage && (
        <button
          className="secondary"
          disabled={library.isFetchingNextPage}
          onClick={() => void library.fetchNextPage()}
        >
          More threads
        </button>
      )}
      {threadId &&
        threads.some(
          (thread) => thread.id === threadId && thread.ownerId === owner,
        ) && (
          <ManagedThread
            key={owner + ':' + threadId}
            owner={owner}
            threadId={threadId}
          />
        )}
    </section>
  )
}
export function ManagedThread({
  owner,
  threadId,
}: {
  owner: string
  threadId: string
}) {
  const snapshot = useCloudThread(owner, threadId)
  const discussion = useThreadDiscussion(threadId)
  const client = useQueryClient()
  const [postId, setPostId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const owned =
    snapshot.data?.thread.ownerId === owner && discussion.owner === owner
  async function restart() {
    if (!owned || busy || discussion.pending) return
    setBusy(true)
    setError('')
    try {
      // Controller owns lifetime and aborts the explicit restart on owner/unmount.
      await discussion.restart()
      void client.invalidateQueries({
        queryKey: accountThreadKey(owner, threadId),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restart discussion.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      {snapshot.isPending && <p role="status">Loading conversation…</p>}
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      {owned && (
        <>
          <label className="account-field">
            <span>Post</span>
            <select
              value={postId}
              onChange={(event) => setPostId(event.target.value)}
            >
              <option value="">Choose a post</option>
              {snapshot.data!.thread.posts.map((post) => (
                <option key={post.id} value={post.id}>
                  {post.position + 1}. {post.text.slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
          {postId &&
            snapshot.data!.thread.posts.some((post) => post.id === postId) && (
              <DeleteConversation
                key={postId}
                owner={owner}
                threadId={threadId}
                postId={postId}
                onDeleted={() => void discussion.refresh()}
              />
            )}
          <div className="privacy-actions">
            <button
              id={'start-discussion-' + threadId}
              className="secondary"
              disabled={
                busy ||
                discussion.pending ||
                !discussion.settings?.aiEnabled ||
                !discussion.settings.consentAt
              }
              onClick={() => void restart()}
            >
              Restart discussion
            </button>
            {discussion.pending && (
              <button
                className="secondary"
                disabled={discussion.cancelling}
                onClick={() => void discussion.cancel()}
              >
                Cancel generation
              </button>
            )}
          </div>
          {discussion.pending && <p role="status">Generating AI replies…</p>}
        </>
      )}
      {(error || discussion.error) && (
        <p role="alert">{error || discussion.error}</p>
      )}
    </div>
  )
}
