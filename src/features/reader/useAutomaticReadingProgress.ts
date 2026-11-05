import { useEffect, useRef } from 'react'
import {
  ApiError,
  type OwnedPost,
  type ReadingProgress,
} from '../../lib/account-thread'
import { saveReadingProgress } from '../account/library'
import {
  erasePrivateDrafts,
  privateDeletionEvent,
  type PrivateDeletion,
} from '../account/private-drafts'

type Options = {
  owner: string
  threadId?: string
  posts: Pick<OwnedPost, 'id' | 'position'>[]
  readPostId?: string | null
  container: HTMLElement | null
  viewKey?: string
  enabled: boolean
  onSaved?: (progress: ReadingProgress) => void
}

// The container scopes source posts; the document, not the thread column, scrolls.
export function useAutomaticReadingProgress(options: Options) {
  const { owner, threadId, posts, readPostId, container, viewKey, enabled } =
    options
  const postKey = JSON.stringify(
    posts.map(({ id, position }) => [id, position]),
  )
  const scope = owner + ':' + threadId
  const latest = useRef(options)
  latest.current = options
  const watermark = useRef({ scope, position: -1 })
  if (watermark.current.scope !== scope)
    watermark.current = { scope, position: -1 }
  const initial = posts.find((post) => post.id === readPostId)?.position ?? -1
  watermark.current.position = Math.max(watermark.current.position, initial)

  useEffect(() => {
    if (
      !enabled ||
      !owner ||
      !threadId ||
      !container ||
      typeof IntersectionObserver === 'undefined'
    )
      return
    let active = true,
      deleted = false,
      sequence = 0
    let observer: IntersectionObserver | null = null
    let debounce: ReturnType<typeof setTimeout> | undefined
    let request: AbortController | undefined
    let candidate: Pick<OwnedPost, 'id' | 'position'> | undefined
    const dwell = new Map<Element, ReturnType<typeof setTimeout>>()
    const positions = new Map(posts.map((post) => [post.id, post]))
    const current = () =>
      active &&
      !deleted &&
      document.visibilityState === 'visible' &&
      latest.current.enabled &&
      latest.current.owner === owner &&
      latest.current.threadId === threadId &&
      latest.current.container === container &&
      latest.current.viewKey === viewKey
    function cancel() {
      sequence++
      observer?.disconnect()
      observer = null
      dwell.forEach(clearTimeout)
      dwell.clear()
      clearTimeout(debounce)
      candidate = undefined
      request?.abort()
      request = undefined
    }
    function qualify(post: Pick<OwnedPost, 'id' | 'position'>) {
      if (
        !current() ||
        post.position <= watermark.current.position ||
        (candidate && post.position <= candidate.position)
      )
        return
      candidate = post
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        const next = candidate
        candidate = undefined
        if (!current() || !next || next.position <= watermark.current.position)
          return
        // No scroll retry loop: each advancing candidate is attempted once.
        watermark.current.position = next.position
        request?.abort()
        const controller = new AbortController(),
          version = ++sequence
        request = controller
        void saveReadingProgress(owner, threadId!, next.id, controller.signal)
          .then((saved) => {
            if (!current() || controller.signal.aborted || sequence !== version)
              return
            const savedPosition = positions.get(saved.postId)?.position
            if (
              savedPosition === undefined ||
              savedPosition < watermark.current.position
            )
              return
            watermark.current.position = savedPosition
            latest.current.onSaved?.(saved)
          })
          .catch((error) => {
            if (
              current() &&
              !controller.signal.aborted &&
              sequence === version &&
              error instanceof ApiError &&
              error.status === 404
            )
              erasePrivateDrafts({ owner, threadId: threadId! })
            // Other quiet metadata failures do not affect reading or source drafts.
          })
      }, 1000)
    }
    function observe() {
      if (!current()) return
      const targets = [
        ...container!.querySelectorAll<HTMLElement>('[data-post-id]'),
      ].filter((element) => positions.has(element.dataset.postId!))
      const height = window.innerHeight
      // Include the reachable tall-post boundary, not just half of the entire post.
      const thresholds = [
        ...new Set([
          0,
          0.5,
          1,
          ...targets.map((element) =>
            Math.min(
              0.5,
              height /
                (2 * Math.max(1, element.getBoundingClientRect().height)),
            ),
          ),
        ]),
      ].sort((a, b) => a - b)
      const binding = new IntersectionObserver(
        (entries) => {
          if (!current() || observer !== binding) return
          for (const entry of entries) {
            const element = entry.target as HTMLElement
            const post = positions.get(element.dataset.postId!)
            if (!post || !container!.contains(element)) continue
            const available = Math.min(
              window.innerHeight,
              entry.rootBounds?.height ?? window.innerHeight,
            )
            const required =
              Math.min(entry.boundingClientRect.height, available) / 2
            const visible =
              entry.isIntersecting &&
              required > 0 &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height >= required
            if (!visible) {
              clearTimeout(dwell.get(element))
              dwell.delete(element)
            } else if (
              !dwell.has(element) &&
              post.position > watermark.current.position
            ) {
              dwell.set(
                element,
                setTimeout(() => {
                  // Keep the entry until it leaves view so repeat notifications do not restart dwell.
                  if (current() && observer === binding) qualify(post)
                }, 500),
              )
            }
          }
        },
        { root: null, threshold: thresholds },
      )
      observer = binding
      targets.forEach((element) => binding.observe(element))
    }
    function visibility() {
      cancel()
      observe()
    }
    function deletion(event: Event) {
      const detail = (event as CustomEvent<PrivateDeletion>).detail
      if (detail.owner !== owner || detail.threadId !== threadId) return
      deleted = true
      cancel()
    }
    observe()
    const layout =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(visibility)
    container
      .querySelectorAll<HTMLElement>('[data-post-id]')
      .forEach((element) => {
        if (positions.has(element.dataset.postId!)) layout?.observe(element)
      })
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', visibility)
    window.addEventListener(privateDeletionEvent, deletion)
    return () => {
      active = false
      layout?.disconnect()
      cancel()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', visibility)
      window.removeEventListener(privateDeletionEvent, deletion)
    }
  }, [owner, threadId, container, viewKey, enabled, postKey])
}
