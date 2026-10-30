import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AccountSettings,
  AppendCommentInput,
  Comment,
  LogicalTurnStatus,
  ThreadSnapshot,
  TurnInput,
  TurnState,
} from '../../lib/account-thread'
import { accountRequest, accountThreadKey } from '../account/library'
import { useAccount } from '../account/auth-client'

export type DiscussionRequest = (
  path: string,
  method?: string,
  input?: unknown,
  signal?: AbortSignal,
  owner?: string,
) => Promise<unknown>
type ControllerOptions = {
  owner: string
  threadId: string
  request: DiscussionRequest
  settings: () => AccountSettings | undefined
  saved: (comment?: Comment) => void
}
export function createDiscussionController(options: ControllerOptions) {
  let state = {
    pending: false,
    saving: false,
    cancelling: false,
    error: '',
    turn: null as TurnState | null,
    input: null as TurnInput | null,
  }
  let active = true,
    operation = 0,
    lifecycle = 0
  const signals = new Set<AbortController>(),
    listeners = new Set<() => void>()
  function update(patch: Partial<typeof state>) {
    if (!active) return
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }
  async function request<T>(path: string, method = 'GET', input?: unknown) {
    const controller = new AbortController()
    signals.add(controller)
    try {
      return (await options.request(
        path,
        method,
        input,
        controller.signal,
        options.owner,
      )) as T
    } finally {
      signals.delete(controller)
    }
  }
  function accept(turn: TurnState | null, cancelled = false) {
    const pending = !!turn && ['reserved', 'running'].includes(turn.status)
    if (!pending) operation++
    update({
      turn,
      pending,
      cancelling: false,
      error:
        turn?.status === 'failed'
          ? 'AI replies could not be generated. Your comment is saved.'
          : turn?.status === 'stale'
            ? 'The thread or settings changed. You can retry.'
            : cancelled
              ? 'Discussion cancelled. Saved comments are kept.'
              : '',
    })
    if (!pending) options.saved()
  }
  async function generate(input: TurnInput) {
    const settings = options.settings()
    if (!active || state.pending || !settings?.aiEnabled || !settings.consentAt)
      return
    const started = ++operation
    update({ pending: true, cancelling: false, input, turn: null, error: '' })
    try {
      const turn = await request<TurnState>('/api/ai/turns', 'POST', input)
      if (active && started === operation) accept(turn)
    } catch (error) {
      if (active && started === operation)
        update({
          pending: false,
          cancelling: false,
          error:
            error instanceof Error
              ? error.message
              : 'AI unavailable. Your comment is saved.',
        })
    }
  }
  return {
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    async submit(input: AppendCommentInput) {
      if (!active || state.saving) return false
      const started = lifecycle
      update({ saving: true, error: '' })
      try {
        const comment = await request<Comment>('/api/comments', 'POST', input)
        if (!active || lifecycle !== started) return false
        options.saved(comment)
        update({ saving: false })
        // Persist the human comment before making any provider request.
        void generate({
          requestId: crypto.randomUUID(),
          threadId: options.threadId,
          kind: 'reply',
          triggerCommentId: comment.id,
        })
        return true
      } catch (error) {
        if (lifecycle !== started) return false
        update({
          saving: false,
          error:
            error instanceof Error
              ? error.message
              : 'Could not save your reply.',
        })
        return false
      }
    },
    generate,
    async restart() {
      if (!active || state.pending) return
      const started = lifecycle
      await request('/api/comments', 'PATCH', { threadId: options.threadId })
      if (!active || lifecycle !== started) return
      await generate({
        requestId: crypto.randomUUID(),
        threadId: options.threadId,
        kind: 'opening',
        triggerCommentId: null,
      })
    },
    retry(requestId: string) {
      if (state.input?.requestId === requestId) return generate(state.input)
    },
    async cancel(_turnId?: string) {
      if (!active || !state.input || !state.pending || state.cancelling) return
      update({ cancelling: true })
      const input = state.input,
        started = operation
      try {
        const result = await request<LogicalTurnStatus>(
          '/api/ai/turns',
          'DELETE',
          input,
        )
        if (!active || operation !== started) return
        // A completed turn wins a cancellation race. Only acknowledge terminal state.
        if (
          result.cancelled ||
          (result.turn && !['reserved', 'running'].includes(result.turn.status))
        ) {
          operation++
          accept(result.turn, result.cancelled)
        } else
          update({
            cancelling: false,
            error: 'Cancellation is not confirmed yet.',
          })
      } catch (error) {
        if (!active || operation !== started) return
        update({
          cancelling: false,
          error:
            error instanceof Error
              ? error.message
              : 'Cancellation could not be confirmed.',
        })
      }
    },
    async refresh() {
      if (!active || !state.pending || !state.input) return
      const started = operation
      try {
        const query = new URLSearchParams({
          ...state.input,
          triggerCommentId: state.input.triggerCommentId ?? '',
        })
        const result = await request<LogicalTurnStatus>(
          '/api/ai/turns?' + query,
        )
        if (
          active &&
          operation === started &&
          (result.turn || result.cancelled)
        )
          accept(result.turn, result.cancelled)
      } catch (error) {
        if (active && operation === started)
          update({
            error:
              error instanceof Error ? error.message : 'Status unavailable.',
          })
      }
    },
    activate() {
      if (!active) {
        active = true
        update({ pending: false, saving: false, cancelling: false })
      }
    },
    dispose() {
      active = false
      lifecycle++
      operation++
      signals.forEach((c) => c.abort())
      signals.clear()
      listeners.clear()
    },
  }
}
export const DiscussionContext = createContext<ReturnType<
  typeof useThreadDiscussion
> | null>(null)
export function useThreadDiscussion(threadId: string) {
  const account = useAccount(),
    owner = account.user?.verified ? account.user.id : ''
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['account', owner, 'settings'],
    enabled: !!owner,
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
  const latestSettings = useRef(settings.data)
  latestSettings.current = settings.data
  const [controller] = useState(() =>
    createDiscussionController({
      owner,
      threadId,
      request: accountRequest,
      settings: () => latestSettings.current,
      saved(comment) {
        const key = accountThreadKey(owner, threadId)
        if (comment)
          client.setQueryData<ThreadSnapshot>(key, (previous) =>
            previous
              ? {
                  ...previous,
                  comments: [
                    ...previous.comments.filter((c) => c.id !== comment.id),
                    comment,
                  ].sort((a, b) => a.sequence - b.sequence),
                }
              : previous,
          )
        void client.invalidateQueries({ queryKey: key })
      },
    }),
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )
  useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  useEffect(() => {
    if (!state.pending) return
    let ticks = 0
    const timer = setInterval(() => {
      if (!document.hidden && ++ticks <= 35) void controller.refresh()
    }, 1500)
    return () => clearInterval(timer)
  }, [state.pending, controller])
  const [settingsError, setSettingsError] = useState(''),
    [settingsBusy, setSettingsBusy] = useState(false)
  const settingsSignal = useRef<AbortController | null>(null)
  useEffect(() => () => settingsSignal.current?.abort(), [])
  async function updateSettings(patch: {
    aiEnabled?: boolean
    memoryEnabled?: boolean
    acknowledgeConsent?: boolean
  }) {
    if (settingsBusy) return false
    const signal = new AbortController()
    settingsSignal.current = signal
    setSettingsBusy(true)
    setSettingsError('')
    try {
      const next = await accountRequest<AccountSettings>(
        '/api/settings',
        'PATCH',
        patch,
        signal.signal,
        owner,
      )
      if (signal.signal.aborted) return false
      latestSettings.current = next
      client.setQueryData(['account', owner, 'settings'], next)
      if (!next.aiEnabled && state.pending) await controller.refresh()
      return true
    } catch (error) {
      if (!signal.signal.aborted)
        setSettingsError(
          error instanceof Error
            ? error.message
            : 'Could not change AI settings.',
        )
      return false
    } finally {
      if (!signal.signal.aborted) setSettingsBusy(false)
    }
  }
  return {
    ...state,
    ...controller,
    owner,
    name: account.user?.name || 'You',
    settings: settings.data,
    settingsBusy,
    settingsError: settingsError || settings.error?.message || '',
    updateSettings,
  }
}
export function useDiscussion(threadId: string, postId: string) {
  const context = useContext(DiscussionContext)
  if (!context) throw Error('Discussion needs its thread provider')
  const client = useQueryClient()
  const snapshot = client.getQueryData<ThreadSnapshot>(
    accountThreadKey(context.owner, threadId),
  )
  const [replyToId, setReplyToId] = useState<string | null>(null)
  return {
    ...context,
    comments: snapshot?.comments.filter((c) => c.postId === postId) ?? [],
    sourceText: snapshot?.thread.record.sourceText ?? '',
    replyToId,
    setReplyToId,
  }
}
