import {
  ApiError,
  type AppendCommentInput,
  type Comment,
  type UserContext,
} from '../../lib/account-thread'
import type { Platform } from '../platform'
import { commentDto, getSnapshot, type CommentRow } from './threads'
import { humanComment, invalid } from './validation'

export async function appendHumanComment(
  p: Platform,
  u: UserContext,
  input: AppendCommentInput,
): Promise<Comment> {
  const value = humanComment(input)
  const snapshot = await getSnapshot(p, u, value.threadId)
  if (!snapshot.thread.posts.some((post) => post.id === value.postId))
    invalid('Invalid post')
  if (
    value.parentId &&
    !snapshot.comments.some(
      (parent) =>
        parent.id === value.parentId && parent.postId === value.postId,
    )
  )
    invalid('Parent must belong to the same post')
  // Sequence allocation and insertion are a single serialized D1 write. Retries
  // never allocate another row; the existing payload is checked below.
  await p.db
    .prepare(
      `INSERT INTO comments (id, thread_id, post_id, owner_id, parent_id, author_kind, author_id, text, sequence, created_at)
    SELECT ?, thread_id, id, owner_id, ?, 'human', ?, ?,
      (SELECT COALESCE(MAX(sequence), 0) + 1 FROM comments WHERE thread_id = ? AND owner_id = ?), ?
    FROM owned_posts WHERE id = ? AND thread_id = ? AND owner_id = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM comments WHERE id = ? AND thread_id = ? AND post_id = ? AND owner_id = ?))
    ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      value.id,
      value.parentId,
      u.userId,
      value.text,
      value.threadId,
      u.userId,
      new Date().toISOString(),
      value.postId,
      value.threadId,
      u.userId,
      value.parentId,
      value.parentId,
      value.threadId,
      value.postId,
      u.userId,
    )
    .run()
  const row = await p.db
    .prepare('SELECT * FROM comments WHERE id = ? AND owner_id = ?')
    .bind(value.id, u.userId)
    .first<CommentRow>()
  if (
    !row ||
    row.thread_id !== value.threadId ||
    row.post_id !== value.postId ||
    row.parent_id !== value.parentId ||
    row.text !== value.text ||
    row.author_kind !== 'human' ||
    row.author_id !== u.userId
  )
    throw new ApiError(
      409,
      'COMMENT_CONFLICT',
      'Comment ID is already used or its target changed',
    )
  return commentDto(row)
}
