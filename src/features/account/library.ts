import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ApiError,
  type LibraryPage,
  type OwnedThread,
  type PatchThreadInput,
  type ThreadSnapshot,
} from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'

export const accountLibraryKey = (owner: string) =>
  ['account', owner, 'library'] as const
export const accountThreadKey = (owner: string, id: string) =>
  ['account', owner, 'thread', id] as const
export async function accountRequest<T>(
  path: string,
  method = 'GET',
  input?: unknown,
  signal?: AbortSignal,
  owner?: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(
      0,
      'OFFLINE',
      'Connection unavailable. Your draft is kept. Retry when connected.',
    )
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined')
      window.dispatchEvent(
        new CustomEvent('threadly:session-expired', { detail: { owner } }),
      )
    const data = (await response.json().catch(() => null)) as {
      code?: string
      message?: string
    } | null
    throw new ApiError(
      response.status,
      data?.code ?? 'REQUEST_FAILED',
      data?.message ?? 'Could not save. Your draft is kept.',
    )
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>)
}
export function useCloudLibrary(userId: string) {
  return useInfiniteQuery({
    queryKey: accountLibraryKey(userId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      accountRequest<LibraryPage>(
        '/api/library' +
          (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''),
        'GET',
        undefined,
        signal,
        userId,
      ),
    getNextPageParam: (page) => page.nextCursor,
    enabled: !!userId,
    retry: false,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  })
}
export function useCloudThread(owner: string, id: string | undefined) {
  return useQuery({
    queryKey: accountThreadKey(owner, id ?? ''),
    queryFn: ({ signal }) =>
      accountRequest<ThreadSnapshot>(
        '/api/threads/' + encodeURIComponent(id!),
        'GET',
        undefined,
        signal,
        owner,
      ),
    enabled: !!owner && !!id,
    retry: false,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  })
}
export async function saveCloudDraft(
  owner: string,
  draft: ThreadRecord,
  current: ThreadSnapshot | null,
  readPostId?: string,
): Promise<{
  draft: ThreadRecord
  snapshot: ThreadSnapshot | null
  error: ApiError | null
}> {
  try {
    if (current && current.thread.ownerId !== owner)
      throw new ApiError(
        403,
        'OWNER_CHANGED',
        'Sign in to the original account to save this draft.',
      )
    let snapshot: ThreadSnapshot
    if (!current) {
      try {
        const thread = await accountRequest<OwnedThread>(
          '/api/library',
          'POST',
          { record: draft },
          undefined,
          owner,
        )
        snapshot = { thread, comments: [], readPostId: null, readAt: null }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error
        // A successful create may have lost its response. Recover the same UUID
        // only when its owner and complete record still match this exact draft.
        const existing = await accountRequest<ThreadSnapshot>(
          '/api/threads/' + draft.id,
          'GET',
          undefined,
          undefined,
          owner,
        )
        const fields: (keyof ThreadRecord)[] = [
          'id',
          'title',
          'posts',
          'sourceUrl',
          'source',
          'media',
          'interactions',
          'date',
          'sourceText',
        ]
        if (
          existing.thread.ownerId !== owner ||
          !fields.every(
            (key) =>
              JSON.stringify(existing.thread.record[key]) ===
              JSON.stringify(draft[key]),
          )
        )
          throw error
        snapshot = existing
      }
    } else {
      const interactions = Object.fromEntries(
        Object.entries(draft.interactions).map(([key, reaction]) => [
          key,
          {
            ...reaction,
            replies: current.thread.record.interactions[key]?.replies ?? [],
          },
        ]),
      )
      const input: PatchThreadInput = {
        expectedRevision: current.thread.revision,
        posts: current.thread.posts.map((post) => ({
          id: post.id,
          text: draft.posts[post.position],
        })),
        interactions,
        ...(readPostId ? { readPostId } : {}),
      }
      snapshot = await accountRequest<ThreadSnapshot>(
        '/api/threads/' + current.thread.id,
        'PATCH',
        input,
        undefined,
        owner,
      )
    }
    return { draft, snapshot, error: null }
  } catch (error) {
    return {
      draft,
      snapshot: null,
      error:
        error instanceof ApiError
          ? error
          : new ApiError(
              0,
              'SAVE_FAILED',
              'Could not save. Your draft is kept.',
            ),
    }
  }
}
