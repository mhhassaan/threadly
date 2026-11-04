import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  type AppendCommentInput,
  type Comment,
  type ThreadSnapshot,
} from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'
import { toLegacyRecord } from '../../lib/legacy-import'
import { draftKey } from './auth-state'
import {
  erasePrivateDrafts,
  privateDeletionEvent,
  scrubConversation,
  type CloudDraft,
  type PrivateDeletion,
} from './private-drafts'
import {
  accountLibraryKey,
  accountRequest,
  accountThreadKey,
  saveCloudDraft,
  savePostReaction,
  useCloudThread,
} from './library'

type Draft = CloudDraft
export function useCloudReader(owner: string, id?: string) {
  const client = useQueryClient()
  const query = useCloudThread(owner, id)
  const key = draftKey(owner, 'thread:' + id)
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(key) || 'null',
      ) as Draft | null
      return value?.base.thread.ownerId === owner && value.base.thread.id === id
        ? value
        : null
    } catch {
      return null
    }
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [reactionBusy, setReactionBusy] = useState(false)
  const reactionSignal = useRef<AbortController | null>(null)
  useEffect(() => () => reactionSignal.current?.abort(), [owner, id])
  const terminalNotFound =
    query.error instanceof ApiError && query.error.status === 404
  const active = useRef(true),
    sending = useRef(false),
    generation = useRef(0),
    currentDraft = useRef(draft)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current++
    }
  }, [owner, id])
  useEffect(() => {
    function onDeletion(event: Event) {
      const detail = (event as CustomEvent<PrivateDeletion>).detail
      if (detail.owner !== owner || detail.threadId !== id) return
      generation.current++
      reactionSignal.current?.abort()
      reactionSignal.current = null
      setReactionBusy(false)
      sending.current = false
      setBusy(false)
      setError('')
      if (detail.postId) {
        if (currentDraft.current)
          retain(scrubConversation(currentDraft.current, detail.postId))
      } else {
        retain(null)
        setDeleted(true)
      }
    }
    window.addEventListener(privateDeletionEvent, onDeletion)
    return () => window.removeEventListener(privateDeletionEvent, onDeletion)
  }, [owner, id])
  useEffect(() => {
    if (terminalNotFound && owner && id) {
      reactionSignal.current?.abort()
      erasePrivateDrafts({ owner, threadId: id })
      client.removeQueries({ queryKey: accountThreadKey(owner, id) })
    }
  }, [terminalNotFound, owner, id, client])
  function retain(next: Draft | null) {
    currentDraft.current = next
    setDraft(next)
    try {
      if (next) sessionStorage.setItem(key, JSON.stringify(next))
      else sessionStorage.removeItem(key)
    } catch {
      setError(
        'Browser storage unavailable. Keep this window open until your draft is saved.',
      )
    }
  }
  const record =
    deleted || terminalNotFound
      ? null
      : (draft?.record ?? (query.data ? toLegacyRecord(query.data) : null))
  async function react(
    index: number,
    flag: 'liked' | 'reposted' | 'bookmarked',
  ) {
    const snapshot = query.data
    if (
      !snapshot ||
      !record ||
      reactionSignal.current ||
      deleted ||
      terminalNotFound
    )
      return
    const post = snapshot.thread.posts[index]
    if (!post) return
    const controller = new AbortController(),
      version = generation.current
    reactionSignal.current = controller
    setReactionBusy(true)
    setError('')
    try {
      const flags = await savePostReaction(
        owner,
        id!,
        post.id,
        { [flag]: !record.interactions[index]?.[flag] },
        controller.signal,
      )
      if (
        controller.signal.aborted ||
        !active.current ||
        version !== generation.current
      )
        return
      client.setQueryData<ThreadSnapshot>(
        accountThreadKey(owner, id!),
        (previous) => {
          if (!previous) return previous
          const source = previous.thread.record
          return {
            ...previous,
            thread: {
              ...previous.thread,
              record: {
                ...source,
                interactions: {
                  ...source.interactions,
                  [index]: {
                    ...source.interactions[index],
                    replies: source.interactions[index]?.replies ?? [],
                    ...flags,
                  },
                },
              },
            },
          }
        },
      )
      if (currentDraft.current) {
        const value = currentDraft.current
        const apply = (source: ThreadRecord): ThreadRecord => ({
          ...source,
          interactions: {
            ...source.interactions,
            [index]: {
              ...source.interactions[index],
              replies: source.interactions[index]?.replies ?? [],
              ...flags,
            },
          },
        })
        retain({
          ...value,
          record: apply(value.record),
          base: {
            ...value.base,
            thread: {
              ...value.base.thread,
              record: apply(value.base.thread.record),
            },
          },
        })
      }
      void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
    } catch (reason) {
      if (
        !controller.signal.aborted &&
        active.current &&
        version === generation.current
      ) {
        if (reason instanceof ApiError && reason.status === 404) {
          erasePrivateDrafts({ owner, threadId: id! })
          client.removeQueries({ queryKey: accountThreadKey(owner, id!) })
          retain(null)
          setDeleted(true)
        } else
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not save reaction. Try again.',
          )
      }
    } finally {
      if (
        !controller.signal.aborted &&
        active.current &&
        version === generation.current
      ) {
        reactionSignal.current = null
        setReactionBusy(false)
      }
    }
  }
  function edit(next: ThreadRecord, readPostId?: string) {
    if (deleted || terminalNotFound) return
    const base = currentDraft.current?.base ?? query.data
    if (!base) return
    retain({
      record: next,
      base,
      readPostId: readPostId ?? currentDraft.current?.readPostId,
    })
  }
  async function save() {
    const value = currentDraft.current
    if (!value || sending.current || deleted || terminalNotFound) return
    const version = generation.current
    sending.current = true
    setBusy(true)
    setError('')
    const result = await saveCloudDraft(
      owner,
      value.record,
      value.base,
      value.readPostId,
    )
    if (!active.current || generation.current !== version) return
    sending.current = false
    setBusy(false)
    if (result.error) {
      if (result.error.status === 404) {
        erasePrivateDrafts({ owner, threadId: id! })
        client.removeQueries({ queryKey: accountThreadKey(owner, id!) })
        return
      }
      setError(
        result.error.status === 409
          ? 'This thread changed on another device. Your draft is kept. Copy your edits, then discard the draft to load the latest version.'
          : result.error.message,
      )
      return
    }
    client.setQueryData(accountThreadKey(owner, id!), result.snapshot)
    if (currentDraft.current === value) retain(null)
    else if (currentDraft.current)
      retain({ ...currentDraft.current, base: result.snapshot! })
    void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
    void client.invalidateQueries({ queryKey: accountThreadKey(owner, id!) })
  }
  async function reply(index: number, text: string): Promise<boolean> {
    const snapshot = query.data ?? draft?.base
    if (!snapshot || sending.current || deleted || terminalNotFound)
      return false
    const version = generation.current
    const replyKey = draftKey(owner, 'reply-request:' + id + ':' + index)
    let input: AppendCommentInput | undefined
    try {
      input =
        JSON.parse(sessionStorage.getItem(replyKey) || 'null') ?? undefined
    } catch {}
    if (!input || input.text !== text)
      input = {
        id: crypto.randomUUID(),
        threadId: id!,
        postId: snapshot.thread.posts[index].id,
        parentId: null,
        text,
      }
    try {
      sessionStorage.setItem(replyKey, JSON.stringify(input))
    } catch {}
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const comment = await accountRequest<Comment>(
        '/api/comments',
        'POST',
        input,
        undefined,
        owner,
      )
      if (!active.current || generation.current !== version) return false
      try {
        sessionStorage.removeItem(replyKey)
      } catch {}
      const latest =
        client.getQueryData<ThreadSnapshot>(accountThreadKey(owner, id!)) ??
        snapshot
      const next = {
        ...latest,
        comments: [
          ...latest.comments.filter((c) => c.id !== comment.id),
          comment,
        ].sort((a, b) => a.sequence - b.sequence),
      }
      client.setQueryData(accountThreadKey(owner, id!), next)
      if (currentDraft.current) {
        // A pending edit keeps its original revision while incorporating the append.
        const base = { ...currentDraft.current.base, comments: next.comments }
        const rendered = toLegacyRecord({
          ...base,
          thread: {
            ...base.thread,
            record: {
              ...currentDraft.current.record,
              interactions: Object.fromEntries(
                Object.entries(currentDraft.current.record.interactions).map(
                  ([k, v]) => [k, { ...v, replies: [] }],
                ),
              ),
            },
          },
        })
        retain({ ...currentDraft.current, base, record: rendered })
      }
      void client.invalidateQueries({ queryKey: accountThreadKey(owner, id!) })
      void client.invalidateQueries({ queryKey: accountLibraryKey(owner) })
      return true
    } catch (reason) {
      if (active.current && generation.current === version) {
        if (reason instanceof ApiError && reason.status === 404) {
          erasePrivateDrafts({ owner, threadId: id! })
          client.removeQueries({ queryKey: accountThreadKey(owner, id!) })
          return false
        }
        setError(
          reason instanceof Error
            ? reason.message
            : 'Reply could not be saved. Retry when connected.',
        )
      }
      return false
    } finally {
      if (active.current && generation.current === version) {
        sending.current = false
        setBusy(false)
      }
    }
  }
  return {
    react,
    reactionBusy,
    notFound: deleted || terminalNotFound,
    record,
    query,
    draft: deleted || terminalNotFound ? null : draft,
    busy,
    error,
    edit,
    save,
    reply,
    readPostId: draft?.readPostId ?? query.data?.readPostId,
    discard: () => {
      retain(null)
      setError('')
      void query.refetch()
    },
  }
}
