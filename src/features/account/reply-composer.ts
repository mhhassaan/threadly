import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export type ReplySubmit = (text: string) => void | Promise<boolean>
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Both reply layouts use this lifecycle; storage is always an owner-scoped key
// supplied by the reader, and guest replies have no private draft storage.
export function createReplyComposer(
  onReply: ReplySubmit,
  key?: string,
  storage?: DraftStorage,
) {
  let value = ''
  try {
    if (key) value = storage?.getItem(key) || ''
  } catch {}
  let state = { value, sending: false },
    active = true,
    generation = 0
  const listeners = new Set<() => void>()
  function update(next: typeof state) {
    state = next
    listeners.forEach((listener) => listener())
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      active = true
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    change(value: string) {
      if (!active || state.sending) return
      update({ value, sending: false })
      try {
        if (key) storage?.setItem(key, value)
      } catch {}
    },
    async submit(): Promise<boolean> {
      if (!active || state.sending || !state.value.trim()) return false
      const started = generation,
        text = state.value.trim()
      update({ ...state, sending: true })
      let saved = false
      try {
        saved = (await onReply(text)) !== false
      } catch {}
      if (!active || generation !== started) return false
      if (saved) {
        try {
          if (key) storage?.removeItem(key)
        } catch {}
      }
      update({ value: saved ? '' : state.value, sending: false })
      return saved
    },
    dispose() {
      active = false
      generation++
      listeners.clear()
    },
  }
}

export function useReplyComposer(onReply: ReplySubmit, storageKey?: string) {
  const latest = useRef(onReply)
  latest.current = onReply
  const [composer] = useState(() => {
    let storage: Storage | undefined
    try {
      storage = sessionStorage
    } catch {}
    return createReplyComposer(
      (text) => latest.current(text),
      storageKey,
      storage,
    )
  })
  const state = useSyncExternalStore(
    composer.subscribe,
    composer.snapshot,
    composer.snapshot,
  )
  useEffect(() => () => composer.dispose(), [composer])
  return { ...state, change: composer.change, submit: composer.submit }
}
