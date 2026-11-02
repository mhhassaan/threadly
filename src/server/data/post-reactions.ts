import type { CommentReaction, UserContext } from '../../lib/account-thread'
import type { Platform } from '../platform'
import { reactionDto, type ReactionRow } from './comment-reactions'
import { notFound, requireVerified } from './threads'
import { invalid, object, uuid } from './validation'

export async function setPostReaction(
  p: Platform,
  u: UserContext,
  threadId: string,
  postId: string,
  patch: Partial<CommentReaction>,
): Promise<CommentReaction> {
  requireVerified(u)
  uuid(threadId)
  uuid(postId)
  const values = object(patch, ['liked', 'reposted', 'bookmarked'])
  for (const value of Object.values(values))
    if (typeof value !== 'boolean') invalid()
  const keys = Object.keys(values)
  const assignments = keys.length
    ? keys.map((key) => `${key} = excluded.${key}`).join(', ')
    : 'post_id = excluded.post_id'
  const flags = ['liked', 'reposted', 'bookmarked'].map((key) =>
    Object.hasOwn(values, key)
      ? '?'
      : `CASE WHEN json_extract(t.record_json, '$.interactions."' || p.position || '".${key}') = 1 THEN 1 ELSE 0 END`,
  )
  const results = await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO post_reactions (post_id, thread_id, owner_id, liked, reposted, bookmarked)
      SELECT p.id, p.thread_id, p.owner_id, ${flags.join(', ')}
      FROM owned_posts p JOIN owned_threads t ON t.id = p.thread_id AND t.owner_id = p.owner_id
      WHERE p.id = ? AND p.thread_id = ? AND p.owner_id = ?
      ON CONFLICT(post_id) DO UPDATE SET ${assignments}`,
      )
      .bind(
        ...['liked', 'reposted', 'bookmarked']
          .filter((key) => Object.hasOwn(values, key))
          .map((key) => (values[key] ? 1 : 0)),
        postId,
        threadId,
        u.userId,
      ),
    p.db
      .prepare(
        'SELECT liked, reposted, bookmarked FROM post_reactions WHERE post_id = ? AND thread_id = ? AND owner_id = ?',
      )
      .bind(postId, threadId, u.userId),
  ])
  const row = results[1].results[0] as ReactionRow | undefined
  if (!row) notFound()
  return reactionDto(row)
}
