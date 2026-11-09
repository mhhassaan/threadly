import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/account-thread'
import { processingNoticeVersion } from '../../lib/ai-processing'
import { validRecord, type ThreadRecord } from '../../lib/thread'
import type {
  GenerationInput,
  GenerationQuota,
  GenerationStatus,
} from '../../lib/thread-generation'
import {
  cancelGeneration,
  ensureGenerationIdentity,
  executeGeneration,
  getGenerationQuota,
  readGeneration,
  readGenerationByRequest,
  startGeneration,
} from './client'

type Input = Omit<GenerationInput, 'requestId' | 'noticeVersion'>
type Pointer = { requestId: string; jobId?: string; cancelled?: boolean }
type State = {
  phase:
    | 'idle'
    | 'preparing'
    | 'writing'
    | 'recovering'
    | 'complete'
    | 'failed'
    | 'cancelled'
  error: string
  quota: GenerationQuota | null
}
type Options = {
  owner: string
  key: string
  isCurrent: () => boolean
  onComplete: (record: ThreadRecord, fresh: boolean) => void | Promise<void>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  onChange?: () => void
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Could not create your thread. Your source is kept.'
const active = (state: State) =>
  ['preparing', 'writing', 'recovering'].includes(state.phase)

// Captures one resolved identity. Recovery only reads; execution is reachable only
// from the explicit start action after identity and admission have both returned.
export function createThreadGeneration(options: Options) {
  let state: State = { phase: 'idle', error: '', quota: null }
  let pointer: Pointer | null = null,
    busy = false,
    cancelled = false
  let flight: AbortController | null = null
  const delivered = new Set<string>()
  const storageKey = 'threadly-generation:' + options.key
  try {
    const value = JSON.parse(options.storage?.getItem(storageKey) ?? 'null')
    if (
      value &&
      typeof value.requestId === 'string' &&
      (!value.jobId || typeof value.jobId === 'string')
    ) {
      pointer = value
      state = { ...state, phase: value.cancelled ? 'cancelled' : 'recovering' }
    }
  } catch {}
  const current = () => !cancelled && options.isCurrent()
  function update(change: Partial<State>) {
    if (options.isCurrent()) {
      state = { ...state, ...change }
      options.onChange?.()
    }
  }
  function persist() {
    try {
      if (pointer) options.storage?.setItem(storageKey, JSON.stringify(pointer))
      else options.storage?.removeItem(storageKey)
    } catch {}
  }
  async function refreshQuota() {
    try {
      const quota = await getGenerationQuota(options.owner)
      update({ quota })
    } catch {}
  }
  async function cleanup(value: Pointer) {
    try {
      const job = value.jobId
        ? { id: value.jobId }
        : await readGenerationByRequest(options.owner, value.requestId)
      await cancelGeneration(options.owner, job.id)
      if (pointer === value) {
        pointer = null
        persist()
        update({ phase: 'cancelled' })
        await refreshQuota()
      }
    } catch {
      /* Retain cancellation marker so a later recovery can only delete. */
    }
  }
  async function accept(job: GenerationStatus, fresh: boolean) {
    if (!current()) {
      if (pointer) await cleanup(pointer)
      return false
    }
    if (pointer) {
      pointer.jobId = job.id
      persist()
    }
    if (job.status === 'complete') {
      if (!job.record?.id || !validRecord(job.record))
        throw Error('The completed thread was invalid. Your source is kept.')
      if (!delivered.has(job.id)) {
        delivered.add(job.id)
        await options.onComplete(job.record, fresh)
      }
      if (!current()) return false
      pointer = null
      persist()
      update({ phase: 'complete', error: '' })
      await refreshQuota()
      return true
    }
    if (['failed', 'cancelled', 'stale'].includes(job.status)) {
      pointer = null
      persist()
      update({
        phase: job.status === 'cancelled' ? 'cancelled' : 'failed',
        error:
          job.status === 'cancelled'
            ? 'Creation cancelled. Your source is kept.'
            : 'Could not create your thread. Your source is kept. Try creating again.',
      })
      await refreshQuota()
      return false
    }
    update({
      phase: 'recovering',
      error:
        job.status === 'reserved'
          ? 'This thread has not started. Cancel it, then create again when ready.'
          : 'Your thread is still being written. Check its status to recover it.',
    })
    return false
  }
  return {
    snapshot: () => state,
    async start(input: Input) {
      if (busy || pointer || !options.isCurrent()) return false
      busy = true
      cancelled = false
      flight = new AbortController()
      update({ phase: 'preparing', error: '' })
      try {
        const quota = await ensureGenerationIdentity(
          options.owner,
          processingNoticeVersion,
          flight.signal,
        )
        if (!current()) return false
        update({ quota })
        if (quota.remaining < 1)
          throw Error(
            quota.kind === 'guest'
              ? 'Your 2 guest threads are used. Sign in to continue.'
              : 'Your daily thread allowance is used. It resets at midnight UTC.',
          )
        pointer = { requestId: crypto.randomUUID() }
        persist()
        const job = await startGeneration(
          options.owner,
          {
            ...input,
            requestId: pointer.requestId,
            noticeVersion: processingNoticeVersion,
          },
          flight.signal,
        )
        if (pointer) {
          pointer.jobId = job.id
          persist()
        }
        if (!current()) {
          if (pointer) await cleanup(pointer)
          return false
        }
        if (job.status !== 'reserved') return await accept(job, false)
        update({ phase: 'writing' })
        return await accept(
          await executeGeneration(options.owner, job.id, flight.signal),
          true,
        )
      } catch (error) {
        if (!current()) {
          if (pointer) await cleanup(pointer)
          return false
        }
        // A lost admission/execution response can hide a successful server write.
        // Retain its identifiers and offer GET recovery, never another paid POST.
        if (
          pointer &&
          (!(error instanceof ApiError) ||
            error.status === 0 ||
            error.status >= 500)
        )
          update({
            phase: 'recovering',
            error:
              'Connection interrupted. Your source is kept. Check the existing thread status before creating again.',
          })
        else {
          pointer = null
          persist()
          update({ phase: 'failed', error: message(error) })
          await refreshQuota()
        }
        return false
      } finally {
        busy = false
        flight = null
      }
    },
    cancel() {
      cancelled = true
      flight?.abort()
      if (pointer) {
        pointer.cancelled = true
        persist()
        void cleanup(pointer)
      }
      update({
        phase: pointer ? 'recovering' : 'cancelled',
        error: 'Creation cancelled. Your source is kept.',
      })
      void refreshQuota()
    },
    async retryStatus() {
      if (busy || !options.isCurrent()) return false
      if (!pointer) {
        await refreshQuota()
        return false
      }
      busy = true
      try {
        if (pointer.cancelled) {
          await cleanup(pointer)
          return false
        }
        cancelled = false
        const job = pointer.jobId
          ? await readGeneration(options.owner, pointer.jobId)
          : await readGenerationByRequest(options.owner, pointer.requestId)
        return await accept(job, false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          pointer = null
          persist()
          update({
            phase: 'failed',
            error:
              'No saved generation was found. Your source is kept. Create again when ready.',
          })
        } else update({ phase: 'recovering', error: message(error) })
        return false
      } finally {
        busy = false
      }
    },
    refreshQuota,
    dispose() {
      cancelled = true
      flight?.abort()
      if (pointer) {
        pointer.cancelled = true
        persist()
        void cleanup(pointer)
      }
    },
  }
}

export function useThreadGeneration({
  owner,
  pending,
  unavailable,
  sessionKey = owner || 'guest',
  enabled = true,
  onComplete,
}: {
  owner: string
  pending: boolean
  unavailable: boolean
  sessionKey?: string
  enabled?: boolean
  onComplete: Options['onComplete']
}) {
  const [, render] = useState(0)
  const latest = useRef({
    owner,
    pending,
    unavailable,
    sessionKey,
    enabled,
    onComplete,
  })
  latest.current = {
    owner,
    pending,
    unavailable,
    sessionKey,
    enabled,
    onComplete,
  }
  const key = owner + ':' + sessionKey
  const controller = useRef<{
    key: string
    value: ReturnType<typeof createThreadGeneration>
  } | null>(null)
  if (!controller.current || controller.current.key !== key) {
    let storage: Storage | undefined
    try {
      storage = sessionStorage
    } catch {}
    controller.current = {
      key,
      value: createThreadGeneration({
        owner,
        key,
        storage,
        isCurrent: () =>
          latest.current.enabled &&
          latest.current.owner + ':' + latest.current.sessionKey === key &&
          !latest.current.pending &&
          !latest.current.unavailable,
        onComplete: (record, fresh) => latest.current.onComplete(record, fresh),
        onChange: () => render((n) => n + 1),
      }),
    }
  }
  const value = controller.current.value
  useEffect(() => {
    if (!enabled || pending || unavailable) return
    void value.refreshQuota()
    void value.retryStatus()
    const refresh = () => {
      void value.refreshQuota()
      void value.retryStatus()
    }
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [value, pending, unavailable, enabled])
  useEffect(() => () => value.dispose(), [value])
  const state = value.snapshot()
  useEffect(() => {
    if (!enabled || pending || unavailable || !state.quota?.resetAt) return
    const delay = Date.parse(state.quota.resetAt) - Date.now()
    if (!Number.isFinite(delay)) return
    const timer = setTimeout(
      () => void value.refreshQuota(),
      Math.min(2147483647, Math.max(1000, delay + 100)),
    )
    return () => clearTimeout(timer)
  }, [value, enabled, pending, unavailable, state.quota?.resetAt])
  return {
    quota: pending || unavailable ? null : state.quota,
    state,
    busy: active(state),
    start: value.start,
    cancel: value.cancel,
    retryStatus: value.retryStatus,
  }
}
