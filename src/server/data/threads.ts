import { reactionDto, type ReactionRow } from './comment-reactions'
import {
  ApiError,
  type UserContext,
  type OwnedThread,
  type ThreadSnapshot,
  type PatchThreadInput,
  type LibraryPage,
  type Comment,
  type ReadingProgress,
} from '../../lib/account-thread'
import type { ThreadRecord } from '../../lib/thread'
import type { Platform } from '../platform'
import {
  invalid,
  interactions,
  threadRecord,
  uuid,
  revision,
} from './validation'

export function requireVerified(user: UserContext) {
  if (!user.verified)
    throw new ApiError(
      403,
      'EMAIL_VERIFICATION_REQUIRED',
      'Verify your email to continue',
    )
}
export function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'Thread not found')
}
export function conflict(): never {
  throw new ApiError(409, 'REVISION_CONFLICT', 'The saved version has changed')
}
type ThreadRow = {
  id: string
  owner_id: string
  revision: number
  source_revision: number
  record_json: string
  opening_blocked: number
  source_text: string | null
}
type PostRow = { id: string; text: string; position: number; revision: number }
export type CommentRow = {
  id: string
  thread_id: string
  post_id: string
  parent_id: string | null
  author_kind: 'human' | 'ai'
  author_id: string
  text: string
  sequence: number
  created_at: string
  turn_id: string | null
  passage_ids: string
  used_memory_ids: string
}
export function commentDto(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.thread_id,
    postId: row.post_id,
    parentId: row.parent_id,
    authorKind: row.author_kind,
    authorId: row.author_id,
    text: row.text,
    sequence: row.sequence,
    createdAt: row.created_at,
    turnId: row.turn_id,
    passageIds: JSON.parse(row.passage_ids),
    usedMemoryIds: JSON.parse(row.used_memory_ids ?? '[]'),
  }
}
function threadDto(
  row: ThreadRow,
  posts: PostRow[],
  reactions: (ReactionRow & { post_id: string })[] = [],
): OwnedThread {
  const record = JSON.parse(row.record_json) as ThreadRecord
  record.posts = posts.map((p) => p.text)
  for (const reaction of reactions) {
    const post = posts.find((post) => post.id === reaction.post_id)
    if (post)
      record.interactions[post.position] = {
        ...record.interactions[post.position],
        replies: record.interactions[post.position]?.replies ?? [],
        ...reactionDto(reaction),
      }
  }
  if (row.source_text !== null) record.sourceText = row.source_text
  return {
    id: row.id,
    ownerId: row.owner_id,
    revision: row.revision,
    sourceRevision: row.source_revision,
    record,
    posts,
  }
}
export async function getSnapshot(
  p: Platform,
  u: UserContext,
  threadId: string,
): Promise<ThreadSnapshot> {
  requireVerified(u)
  uuid(threadId)
  const results = await p.db.batch([
    p.db
      .prepare('SELECT * FROM owned_threads WHERE id = ? AND owner_id = ?')
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT id, text, position, revision FROM owned_posts WHERE thread_id = ? AND owner_id = ? ORDER BY position',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT * FROM comments WHERE thread_id = ? AND owner_id = ? ORDER BY sequence',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT post_id, read_at FROM reading_progress WHERE thread_id = ? AND owner_id = ?',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT 1 FROM legacy_imports WHERE thread_id = ? AND owner_id = ?',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT comment_id, liked, reposted, bookmarked FROM comment_reactions WHERE thread_id = ? AND owner_id = ?',
      )
      .bind(threadId, u.userId),
    p.db
      .prepare(
        'SELECT post_id, liked, reposted, bookmarked FROM post_reactions WHERE thread_id = ? AND owner_id = ?',
      )
      .bind(threadId, u.userId),
  ])
  const row = results[0].results[0] as ThreadRow | undefined
  if (!row) notFound()
  const read = results[3].results[0] as
    { post_id: string; read_at: string } | undefined
  return {
    thread: threadDto(
      row,
      results[1].results as PostRow[],
      results[6].results as (ReactionRow & { post_id: string })[],
    ),
    comments: (results[2].results as CommentRow[]).map(commentDto),
    commentReactions: Object.fromEntries(
      (results[5].results as (ReactionRow & { comment_id: string })[]).map(
        (row) => [row.comment_id, reactionDto(row)],
      ),
    ),
    isImported: results[4].results.length > 0,
    openingBlocked: !!row.opening_blocked,
    readPostId: read?.post_id ?? null,
    readAt: read?.read_at ?? null,
  }
}

// A conditional first statement and mutation token gate every dependent write in
// the same D1 transaction. A stale request can never update posts or progress.
async function updateThread(
  p: Platform,
  u: UserContext,
  current: OwnedThread,
  record: ThreadRecord,
  expectedRevision: number,
  readPostId?: string,
  includesLegacyReactions = true,
): Promise<OwnedThread> {
  revision(expectedRevision)
  if (current.revision !== expectedRevision) conflict()
  if (record.posts.length !== current.posts.length)
    invalid('Edit existing posts by stable ID')
  if (readPostId && !current.posts.some((post) => post.id === readPostId))
    invalid('Invalid reading post')
  const mutation = crypto.randomUUID()
  const now = new Date().toISOString()
  const preserved = { ...record }
  if (current.record.sourceText !== undefined)
    preserved.sourceText = current.record.sourceText
  else delete preserved.sourceText
  // Legacy full-map flags cannot express a baseline for concurrent metadata.
  // Once dedicated flags exist, reject disagreement atomically rather than
  // silently overwriting or dropping either editor's intent.
  const statements = [
    p.db
      .prepare(
        `UPDATE owned_threads SET record_json = ?, revision = revision + 1, mutation_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?
         AND (? = 0 OR NOT EXISTS (
           SELECT 1 FROM post_reactions r JOIN owned_posts p ON p.id = r.post_id AND p.thread_id = r.thread_id AND p.owner_id = r.owner_id
           LEFT JOIN json_each(?) j ON j.key = CAST(p.position AS TEXT)
           WHERE r.thread_id = owned_threads.id AND r.owner_id = owned_threads.owner_id
           AND (COALESCE(json_extract(j.value, '$.liked'), 0) <> r.liked
             OR COALESCE(json_extract(j.value, '$.reposted'), 0) <> r.reposted
             OR COALESCE(json_extract(j.value, '$.bookmarked'), 0) <> r.bookmarked)
         ))`,
      )
      .bind(
        JSON.stringify(preserved),
        mutation,
        now,
        current.id,
        u.userId,
        expectedRevision,
        includesLegacyReactions ? 1 : 0,
        JSON.stringify(preserved.interactions),
      ),
  ]
  // Synchronization revisions still advance for metadata saves. Rebase only
  // matching evidence, behind THIS mutation's CAS, so stale evidence stays stale.
  const contentFields = [
    'id',
    'date',
    'title',
    'posts',
    'sourceUrl',
    'source',
    'media',
    'sourceText',
  ] as const
  const embeddedReplies = (value: ThreadRecord) =>
    current.posts.map(
      (post) => value.interactions[post.position]?.replies ?? [],
    )
  const metadataOnly =
    contentFields.every(
      (field) =>
        JSON.stringify(preserved[field]) ===
        JSON.stringify(current.record[field]),
    ) &&
    JSON.stringify(embeddedReplies(preserved)) ===
      JSON.stringify(embeddedReplies(current.record))
  if (metadataOnly)
    statements.push(
      p.db
        .prepare(
          `UPDATE memory_evidence SET thread_revision = thread_revision + 1
         WHERE thread_revision = ? AND source_revision = ?
         AND comment_id IN (SELECT id FROM comments WHERE thread_id = ? AND owner_id = ?)
         AND EXISTS (SELECT 1 FROM owned_threads WHERE id = ? AND owner_id = ? AND mutation_id = ?)`,
        )
        .bind(
          expectedRevision,
          current.sourceRevision,
          current.id,
          u.userId,
          current.id,
          u.userId,
          mutation,
        ),
    )
  for (const post of current.posts) {
    const text = preserved.posts[post.position]
    if (post.text === text) continue
    statements.push(
      p.db
        .prepare(
          'UPDATE owned_posts SET text = ?, revision = revision + 1 WHERE id = ? AND thread_id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM owned_threads WHERE id = ? AND owner_id = ? AND mutation_id = ?)',
        )
        .bind(
          text,
          post.id,
          current.id,
          u.userId,
          current.id,
          u.userId,
          mutation,
        ),
    )
  }
  if (readPostId)
    statements.push(
      p.db
        .prepare(
          'INSERT INTO reading_progress (thread_id, owner_id, post_id, read_at) SELECT id, owner_id, ?, ? FROM owned_threads WHERE id = ? AND owner_id = ? AND mutation_id = ? ON CONFLICT(thread_id) DO UPDATE SET post_id = excluded.post_id, read_at = excluded.read_at',
        )
        .bind(readPostId, now, current.id, u.userId, mutation),
    )
  const result = await p.db.batch(statements)
  if (result[0].meta.changes !== 1) conflict()
  return (await getSnapshot(p, u, current.id)).thread
}
export async function saveThread(
  p: Platform,
  u: UserContext,
  input: ThreadRecord,
  expectedRevision: number | null,
): Promise<OwnedThread> {
  requireVerified(u)
  const record = threadRecord(input)
  if (expectedRevision !== null) {
    const current = (await getSnapshot(p, u, record.id)).thread
    return updateThread(p, u, current, record, expectedRevision)
  }
  const now = new Date().toISOString()
  const posts = record.posts.map((text, position) => ({
    id: crypto.randomUUID(),
    text,
    position,
    revision: 1,
  }))
  const statements = [
    p.db
      .prepare(
        'INSERT INTO owned_threads (id, owner_id, record_json, source_text, mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        record.id,
        u.userId,
        JSON.stringify(record),
        record.sourceText ?? null,
        crypto.randomUUID(),
        now,
        now,
      ),
  ]
  statements.push(
    ...posts.map((post) =>
      p.db
        .prepare(
          'INSERT INTO owned_posts (id, thread_id, owner_id, text, position) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(post.id, record.id, u.userId, post.text, post.position),
    ),
  )
  try {
    await p.db.batch(statements)
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: owned_threads.id'))
      conflict()
    throw error
  }
  return {
    id: record.id,
    ownerId: u.userId,
    record,
    posts,
    revision: 1,
    sourceRevision: 1,
  }
}
export async function patchOwnedThread(
  p: Platform,
  u: UserContext,
  threadId: string,
  input: PatchThreadInput,
): Promise<ThreadSnapshot> {
  const snapshot = await getSnapshot(p, u, threadId)
  const record = {
    ...snapshot.thread.record,
    posts: [...snapshot.thread.record.posts],
  }
  for (const edit of input.posts ?? []) {
    const post = snapshot.thread.posts.find((post) => post.id === edit.id)
    if (!post) invalid('Invalid post')
    record.posts[post.position] = edit.text
  }
  if (input.interactions !== undefined)
    record.interactions = interactions(input.interactions, record.posts.length)
  await updateThread(
    p,
    u,
    snapshot.thread,
    threadRecord(record),
    input.expectedRevision,
    input.readPostId,
    input.interactions !== undefined,
  )
  return getSnapshot(p, u, threadId)
}
export async function listThreads(
  p: Platform,
  u: UserContext,
  cursor: string | null = null,
): Promise<LibraryPage> {
  requireVerified(u)
  if (cursor !== null) uuid(cursor)
  const rows = await p.db
    .prepare(
      'SELECT * FROM owned_threads WHERE owner_id = ? AND id > ? ORDER BY id LIMIT 51',
    )
    .bind(u.userId, cursor ?? '')
    .all<ThreadRow>()
  const page = rows.results.slice(0, 50)
  const threads: OwnedThread[] = []
  if (page.length) {
    const results = await p.db.batch(
      page
        .map((row) =>
          p.db
            .prepare(
              'SELECT id, text, position, revision FROM owned_posts WHERE thread_id = ? AND owner_id = ? ORDER BY position',
            )
            .bind(row.id, u.userId),
        )
        .concat(
          page.map((row) =>
            p.db
              .prepare(
                'SELECT post_id, liked, reposted, bookmarked FROM post_reactions WHERE thread_id = ? AND owner_id = ?',
              )
              .bind(row.id, u.userId),
          ),
        ),
    )
    page.forEach((row, i) =>
      threads.push(
        threadDto(
          row,
          results[i].results as PostRow[],
          results[i + page.length].results as (ReactionRow & {
            post_id: string
          })[],
        ),
      ),
    )
  }
  return {
    threads,
    nextCursor: rows.results.length > 50 ? page.at(-1)!.id : null,
  }
}
export async function saveReadProgress(
  p: Platform,
  u: UserContext,
  threadId: string,
  postId: string,
): Promise<ReadingProgress> {
  requireVerified(u)
  uuid(threadId)
  uuid(postId)
  const owned = await p.db
    .prepare('SELECT 1 FROM owned_threads WHERE id = ? AND owner_id = ?')
    .bind(threadId, u.userId)
    .first()
  if (!owned) notFound()
  const post = await p.db
    .prepare(
      'SELECT 1 FROM owned_posts WHERE id = ? AND thread_id = ? AND owner_id = ?',
    )
    .bind(postId, threadId, u.userId)
    .first()
  if (!post) invalid('Invalid reading post')
  const results = await p.db.batch([
    p.db
      .prepare(
        `INSERT INTO reading_progress (thread_id, owner_id, post_id, read_at)
      SELECT thread_id, owner_id, id, ? FROM owned_posts WHERE id = ? AND thread_id = ? AND owner_id = ?
      ON CONFLICT(thread_id) DO UPDATE SET post_id = excluded.post_id, read_at = excluded.read_at
      WHERE (SELECT position FROM owned_posts WHERE id = excluded.post_id AND thread_id = excluded.thread_id AND owner_id = excluded.owner_id)
        > (SELECT position FROM owned_posts WHERE id = reading_progress.post_id AND thread_id = reading_progress.thread_id AND owner_id = reading_progress.owner_id)`,
      )
      .bind(new Date().toISOString(), postId, threadId, u.userId),
    p.db
      .prepare(
        'SELECT post_id, read_at FROM reading_progress WHERE thread_id = ? AND owner_id = ? AND EXISTS (SELECT 1 FROM owned_posts WHERE id = ? AND thread_id = ? AND owner_id = ?)',
      )
      .bind(threadId, u.userId, postId, threadId, u.userId),
  ])
  const row = results[1].results[0] as
    { post_id: string; read_at: string } | undefined
  if (!row) notFound()
  return { postId: row.post_id, readAt: row.read_at }
}

export async function deleteThread(
  p: Platform,
  u: UserContext,
  threadId: string,
): Promise<void> {
  requireVerified(u)
  uuid(threadId)
  const result = await p.db
    .prepare('DELETE FROM owned_threads WHERE id = ? AND owner_id = ?')
    .bind(threadId, u.userId)
    .run()
  if (!result.meta.changes) notFound()
}
