export type Mode = 'text' | 'url' | 'file'
export type Depth = 'quick' | 'balanced' | 'detailed'
export interface Media {
  type: string
  url: string
  alt?: string
  caption?: string
  poster?: string
  title?: string
  position?: number
  postIndex?: number
}
export interface Source {
  name: string
  handle: string
  url?: string
  icon?: string
}
export interface Reaction {
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  replies: { text: string; date: string }[]
}
export interface ThreadRecord {
  id: string
  title: string
  posts: string[]
  sourceUrl: string
  source: Source | null
  media: Media[]
  interactions: Record<string, Reaction>
  date?: string
  sourceText?: string
}
export function validRecord(value: unknown): value is ThreadRecord {
  const d = value as ThreadRecord
  return (
    !!d &&
    typeof d.title === 'string' &&
    Array.isArray(d.posts) &&
    d.posts.length > 0 &&
    d.posts.length <= 100 &&
    d.posts.every((p) => typeof p === 'string')
  )
}
export function normalizeRecord(d: ThreadRecord): ThreadRecord {
  return {
    ...d,
    id: d.id || crypto.randomUUID(),
    sourceUrl: d.sourceUrl || '',
    source: d.source || null,
    media: Array.isArray(d.media) ? d.media : [],
    interactions:
      d.interactions && typeof d.interactions === 'object'
        ? d.interactions
        : {},
  }
}
export const libraryKey = 'threadly-library'
export const cacheKey = (token: string) => 'threadly-reader-' + token
export function loadLibrary(): ThreadRecord[] {
  try {
    const a = JSON.parse(localStorage.getItem(libraryKey) || '[]')
    return Array.isArray(a) ? a.filter(validRecord).map(normalizeRecord) : []
  } catch {
    return []
  }
}
export function remoteUrl(value?: string) {
  try {
    if (!value) return ''
    const u = new URL(value)
    return ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : ''
  } catch {
    return ''
  }
}
export function mediaUrl(value?: string) {
  const u = remoteUrl(value)
  return u ? '/api/media?url=' + encodeURIComponent(u) : ''
}
export function textMedia(text: string): Media[] {
  const result: Media[] = []
  for (const m of text.matchAll(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
  )) {
    if (result.length >= 16) break
    const url = remoteUrl(m[2])
    if (url && !result.some((i) => i.url === url))
      result.push({
        type: 'image',
        url,
        alt: m[1] || 'Image from the text source',
        caption: '',
        position: m.index / Math.max(text.length, 1),
      })
  }
  return result
}
export function assignMedia(items: Media[], posts: string[], text: string) {
  const normalized = text.replace(/\s+/g, ' ')
  const positions = posts.map(
    (p) =>
      Math.max(0, normalized.indexOf(p.slice(0, 60))) /
      Math.max(1, normalized.length),
  )
  return items
    .filter((m) => remoteUrl(m.url))
    .map((m) => {
      let index = 0
      positions.forEach((p, i) => {
        if (p <= (m.position || 0)) index = i
      })
      return { ...m, postIndex: index }
    })
}
