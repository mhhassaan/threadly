import { ApiError } from '../../lib/account-thread'

export function validateGeneratedThread(
  value: unknown,
  finishReason: unknown,
): { title: string; posts: string[] } {
  const invalid = () =>
    new ApiError(
      502,
      'INVALID_GENERATED_THREAD',
      'The AI returned an incomplete thread. Please try again.',
    )
  if (
    finishReason !== 'stop' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw invalid()
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).length !== 2 ||
    !Object.hasOwn(result, 'title') ||
    !Object.hasOwn(result, 'posts') ||
    typeof result.title !== 'string' ||
    !result.title.trim() ||
    [...result.title].length > 100 ||
    !Array.isArray(result.posts) ||
    result.posts.length < 1 ||
    result.posts.length > 100
  )
    throw invalid()
  const posts: string[] = []
  const seen = new Set<string>()
  for (const post of result.posts) {
    if (typeof post !== 'string' || !post.trim() || [...post].length > 1200)
      throw invalid()
    const normalized = post.trim().replace(/\s+/g, ' ').toLowerCase()
    if (seen.has(normalized)) throw invalid()
    seen.add(normalized)
    posts.push(post.trim())
  }
  return { title: result.title.trim(), posts }
}
