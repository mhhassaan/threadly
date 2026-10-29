import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog } from '../../components/Dialog'
import { accountRequest, accountThreadKey } from '../account/library'
import { draftKey } from '../account/auth-state'
import { openingIntentKey } from './ConsentNotice'
export function DeleteConversation({
  owner,
  threadId,
  postId,
  onDeleted,
}: {
  owner: string
  threadId: string
  postId: string
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null),
    abort = useRef(new AbortController()),
    client = useQueryClient()
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    return () => controller.abort()
  }, [])
  function close() {
    if (busy) return
    setOpen(false)
    setError('')
    requestAnimationFrame(() => trigger.current?.focus())
  }
  async function remove() {
    setBusy(true)
    setError('')
    try {
      await accountRequest(
        '/api/comments',
        'DELETE',
        { threadId, postId },
        abort.current.signal,
        owner,
      )
      if (abort.current.signal.aborted) return
      await client.cancelQueries({ queryKey: ['account', owner] })
      try {
        const prefix = draftKey(
          owner,
          'comment:' + threadId + ':' + postId + ':',
        )
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i)
          if (key?.startsWith(prefix)) sessionStorage.removeItem(key)
        }
        sessionStorage.removeItem(openingIntentKey(owner, threadId))
      } catch {}
      client.setQueryData(
        accountThreadKey(owner, threadId),
        (
          snapshot:
            import('../../lib/account-thread').ThreadSnapshot | undefined,
        ) =>
          snapshot
            ? {
                ...snapshot,
                openingBlocked: true,
                comments: snapshot.comments.filter((c) => c.postId !== postId),
              }
            : snapshot,
      )
      void client.invalidateQueries({ queryKey: ['account', owner] })
      onDeleted()
      setOpen(false)
      requestAnimationFrame(() => {
        if (trigger.current?.isConnected) trigger.current.focus()
        else document.getElementById('start-discussion-' + threadId)?.focus()
      })
    } catch (e) {
      if (!abort.current.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Could not delete the conversation.',
        )
    } finally {
      if (!abort.current.signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      <button
        ref={trigger}
        className="text-button"
        onClick={() => setOpen(true)}
      >
        Delete conversation
      </button>
      {open && (
        <Dialog title="Delete conversation?" onClose={close}>
          <p>
            Delete all human and AI comments on this post, and memories
            supported by them. The saved thread stays. AI will wait until you
            explicitly start a discussion again.
          </p>
          <div className="privacy-actions">
            <button
              data-autofocus
              className="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              className="account-discard"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting...' : 'Delete conversation'}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </>
  )
}
