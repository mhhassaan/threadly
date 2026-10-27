import {
  ApiError,
  type AppendCommentInput,
  type PatchThreadInput,
} from '../../lib/account-thread'
import type { Reaction, ThreadRecord } from '../../lib/thread'

// The supported 100k-character source may remain one complete-thought post.
const maxPostCharacters = 100_000

export function invalid(message = 'Invalid request'): never {
  throw new ApiError(400, 'INVALID_INPUT', message)
}
export function object(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key)))
    invalid('Unknown field')
  return result
}
export function string(value: unknown, max: number, allowEmpty = true): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    invalid()
  return value
}
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    invalid('Invalid ID')
  return value
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid('Invalid revision')
  return value
}
export function interactions(
  value: unknown,
  postCount: number,
): Record<string, Reaction> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result: Record<string, Reaction> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= postCount)
      invalid('Invalid reaction post')
    const reaction = object(entry, [
      'liked',
      'reposted',
      'bookmarked',
      'replies',
    ])
    for (const field of ['liked', 'reposted', 'bookmarked'])
      if (reaction[field] !== undefined && typeof reaction[field] !== 'boolean')
        invalid()
    if (!Array.isArray(reaction.replies) || reaction.replies.length > 100)
      invalid()
    const replies = reaction.replies.map((v) => {
      const r = object(v, ['text', 'date'])
      return { text: string(r.text, 2000), date: string(r.date, 100) }
    })
    result[key] = { ...reaction, replies } as Reaction
  }
  return result
}
export function threadRecord(value: unknown): ThreadRecord {
  const v = object(value, [
    'id',
    'title',
    'posts',
    'sourceUrl',
    'source',
    'media',
    'interactions',
    'date',
    'sourceText',
  ])
  if (!Array.isArray(v.posts) || v.posts.length < 1 || v.posts.length > 100)
    invalid('Invalid posts')
  const posts = v.posts.map((p) => string(p, maxPostCharacters, false))
  let source: ThreadRecord['source'] = null
  if (v.source != null) {
    const s = object(v.source, ['name', 'handle', 'url', 'icon'])
    source = { name: string(s.name, 500), handle: string(s.handle, 500) }
    if (s.url !== undefined) source.url = string(s.url, 4000)
    if (s.icon !== undefined) source.icon = string(s.icon, 4000)
  }
  if (
    v.media !== undefined &&
    (!Array.isArray(v.media) || v.media.length > 100)
  )
    invalid()
  const media = ((v.media ?? []) as unknown[]).map((entry) => {
    const m = object(entry, [
      'type',
      'url',
      'alt',
      'caption',
      'poster',
      'title',
      'position',
      'postIndex',
    ])
    const result: ThreadRecord['media'][number] = {
      type: string(m.type, 100),
      url: string(m.url, 4000),
    }
    for (const key of ['alt', 'caption', 'poster', 'title'] as const)
      if (m[key] !== undefined) result[key] = string(m[key], 4000)
    if (m.position !== undefined) {
      if (
        typeof m.position !== 'number' ||
        !Number.isFinite(m.position) ||
        m.position < 0 ||
        m.position > 1
      )
        invalid()
      result.position = m.position
    }
    if (m.postIndex !== undefined) {
      if (
        typeof m.postIndex !== 'number' ||
        !Number.isInteger(m.postIndex) ||
        m.postIndex < 0 ||
        m.postIndex >= posts.length
      )
        invalid()
      result.postIndex = m.postIndex
    }
    return result
  })
  const result: ThreadRecord = {
    id: uuid(v.id),
    title: string(v.title, 500),
    posts,
    sourceUrl: string(v.sourceUrl ?? '', 4000),
    source,
    media,
    interactions: interactions(v.interactions ?? {}, posts.length),
  }
  if (v.date !== undefined) result.date = string(v.date, 100)
  if (v.sourceText !== undefined)
    result.sourceText = string(v.sourceText, 500_000)
  return result
}
export function patchThread(value: unknown): PatchThreadInput {
  const v = object(value, [
    'expectedRevision',
    'posts',
    'interactions',
    'readPostId',
  ])
  const result: PatchThreadInput = {
    expectedRevision: revision(v.expectedRevision),
  }
  if (v.posts !== undefined) {
    if (!Array.isArray(v.posts) || v.posts.length < 1 || v.posts.length > 100)
      invalid()
    result.posts = v.posts.map((entry) => {
      const post = object(entry, ['id', 'text'])
      return {
        id: uuid(post.id),
        text: string(post.text, maxPostCharacters, false),
      }
    })
    if (new Set(result.posts.map((p) => p.id)).size !== result.posts.length)
      invalid('Duplicate post ID')
  }
  if (v.interactions !== undefined)
    result.interactions = interactions(v.interactions, 100)
  if (v.readPostId !== undefined) result.readPostId = uuid(v.readPostId)
  if (
    result.posts === undefined &&
    result.interactions === undefined &&
    result.readPostId === undefined
  )
    invalid('Empty update')
  return result
}
export function humanComment(value: unknown): AppendCommentInput {
  const v = object(value, ['id', 'threadId', 'postId', 'parentId', 'text'])
  return {
    id: uuid(v.id),
    threadId: uuid(v.threadId),
    postId: uuid(v.postId),
    parentId: v.parentId === null ? null : uuid(v.parentId),
    text: string(v.text, 2000, false),
  }
}
