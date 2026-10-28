import {
  ApiError,
  type OwnedThread,
  type UserContext,
} from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'
import type { Platform } from '../platform'
import { getSnapshot, requireVerified } from './threads'
import { invalid, threadRecord, uuid } from './validation'

// A single D1 batch commits the thread, all posts/replies and the resume marker.
// The marker is owner scoped, so importing on another account cannot claim it.
export async function importLocalThread(
  p: Platform,
  u: UserContext,
  input: { migrationId: string; record: ThreadRecord },
): Promise<OwnedThread> {
  requireVerified(u)
  const migrationId = uuid(input.migrationId),
    legacy = threadRecord(input.record)
  const existing = () =>
    p.db
      .prepare(
        'SELECT thread_id, legacy_id FROM legacy_imports WHERE owner_id = ? AND (migration_id = ? OR legacy_id = ?)',
      )
      .bind(u.userId, migrationId, legacy.id)
      .first<{ thread_id: string; legacy_id: string }>()
  const previous = await existing()
  if (previous) {
    if (previous.legacy_id !== legacy.id)
      throw new ApiError(
        409,
        'IMPORT_CONFLICT',
        'Import key already belongs to another local thread',
      )
    return (await getSnapshot(p, u, previous.thread_id)).thread
  }
  const id = crypto.randomUUID(),
    now = new Date().toISOString()
  const record: ThreadRecord = { ...legacy, id, interactions: {} }
  const posts = legacy.posts.map((text, position) => ({
    id: crypto.randomUUID(),
    text,
    position,
  }))
  const replies: { id: string; postId: string; text: string; date: string }[] =
    []
  for (const [position, reaction] of Object.entries(legacy.interactions)) {
    record.interactions[position] = { ...reaction, replies: [] }
    for (const reply of reaction.replies) {
      if (!reply.text.trim()) invalid('A local reply is empty')
      replies.push({
        id: crypto.randomUUID(),
        postId: posts[Number(position)].id,
        ...reply,
      })
    }
  }
  const statements = [
    p.db
      .prepare(
        'INSERT INTO owned_threads (id, owner_id, record_json, source_text, mutation_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM legacy_imports WHERE owner_id = ? AND (migration_id = ? OR legacy_id = ?))',
      )
      .bind(
        id,
        u.userId,
        JSON.stringify(record),
        record.sourceText ?? null,
        crypto.randomUUID(),
        now,
        now,
        u.userId,
        migrationId,
        legacy.id,
      ),
  ]
  for (const post of posts)
    statements.push(
      p.db
        .prepare(
          'INSERT INTO owned_posts (id, thread_id, owner_id, text, position) SELECT ?, id, owner_id, ?, ? FROM owned_threads WHERE id = ? AND owner_id = ?',
        )
        .bind(post.id, post.text, post.position, id, u.userId),
    )
  replies.forEach((reply, index) =>
    statements.push(
      p.db
        .prepare(
          "INSERT INTO comments (id, thread_id, post_id, owner_id, parent_id, author_kind, author_id, text, sequence, created_at) SELECT ?, id, ?, owner_id, NULL, 'human', owner_id, ?, ?, ? FROM owned_threads WHERE id = ? AND owner_id = ?",
        )
        .bind(
          reply.id,
          reply.postId,
          reply.text,
          index + 1,
          reply.date,
          id,
          u.userId,
        ),
    ),
  )
  statements.push(
    p.db
      .prepare(
        'INSERT INTO legacy_imports (owner_id, migration_id, legacy_id, thread_id) SELECT owner_id, ?, ?, id FROM owned_threads WHERE id = ? AND owner_id = ?',
      )
      .bind(migrationId, legacy.id, id, u.userId),
  )
  await p.db.batch(statements)
  const imported = await existing()
  if (!imported || imported.legacy_id !== legacy.id)
    throw new ApiError(
      409,
      'IMPORT_CONFLICT',
      'Import key already belongs to another local thread',
    )
  return (await getSnapshot(p, u, imported.thread_id)).thread
}
