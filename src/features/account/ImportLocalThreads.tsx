import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { migrationIdFor } from '../../lib/legacy-import'
import type { OwnedThread } from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'
import { accountLibraryKey, accountRequest } from './library'

export function ImportLocalThreads({
  owner,
  records,
}: {
  owner: string
  records: ThreadRecord[]
}) {
  const client = useQueryClient(),
    active = useRef(true)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  if (!records.length) return null
  async function importRecords() {
    if (busy) return
    setBusy(true)
    setMessage('')
    let completed = 0
    try {
      for (const record of records) {
        if (!active.current) return
        const migrationId = migrationIdFor(localStorage, owner, record.id)
        await accountRequest<OwnedThread>(
          '/api/library',
          'POST',
          { migrationId, record },
          undefined,
          owner,
        )
        if (!active.current) return
        completed++
        setMessage(`Imported ${completed} of ${records.length}.`)
        void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
      }
      setMessage(
        'Import complete. Original device copies are kept. You can safely run import again.',
      )
    } catch (reason) {
      if (active.current)
        setMessage(
          `Imported ${completed} of ${records.length}. ${reason instanceof Error ? reason.message : 'Import failed.'} Select import again to resume.`,
        )
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return (
    <section aria-label="Import device threads">
      <p>
        {records.length} saved threads are on this device. Import them into your
        private account library, including existing replies. Device copies stay
        here.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void importRecords()}
      >
        {busy ? 'Importing…' : 'Import device threads'}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  )
}
