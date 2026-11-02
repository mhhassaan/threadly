import type { CommentReaction, UserContext } from '../../lib/account-thread'
import type { Platform } from '../platform'
import { notFound, requireVerified } from './threads'
import { invalid, object, uuid } from './validation'

export type ReactionRow = {
  liked: number
  reposted: number
  bookmarked: number
}
export function reactionDto(row: ReactionRow): CommentReaction {
  return {
    liked: !!row.liked,
    reposted: !!row.reposted,
    bookmarked: !!row.bookmarked,
  }
}
export async function setCommentReaction(
  p: Platform,
  u: UserContext,
  commentId: string,
  patch: Partial<CommentReaction>,
): Promise<CommentReaction> {
  requireVerified(u)
  uuid(commentId)
  const values = object(patch, ['liked', 'reposted', 'bookmarked'])
  for (const value of Object.values(values))
    if (typeof value !== 'boolean') invalid()
  const keys = Object.keys(values)
  // One atomic desired-state upsert; independent patches never overwrite flags
  // they did not supply. SELECT also fences deletion and foreign ownership.
  const assignments = keys.length
    ? keys.map((key) => `${key} = excluded.${key}`).join(', ')
    : 'comment_id = excluded.comment_id'
  const results = await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO comment_reactions (comment_id, thread_id, post_id, owner_id, liked, reposted, bookmarked)
      SELECT id, thread_id, post_id, owner_id, ?, ?, ? FROM comments WHERE id = ? AND owner_id = ?
      ON CONFLICT(comment_id) DO UPDATE SET ${assignments}`,
      )
      .bind(
        patch.liked ? 1 : 0,
        patch.reposted ? 1 : 0,
        patch.bookmarked ? 1 : 0,
        commentId,
        u.userId,
      ),
    p.db
      .prepare(
        'SELECT comment_id, liked, reposted, bookmarked FROM comment_reactions WHERE comment_id = ? AND owner_id = ?',
      )
      .bind(commentId, u.userId),
  ])
  const row = results[1].results[0] as ReactionRow | undefined
  if (!row) notFound()
  return reactionDto(row)
}
