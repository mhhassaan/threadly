import {
  sqliteTable,
  text,
  integer,
  unique,
  foreignKey,
  index,
} from 'drizzle-orm/sqlite-core'
import { user } from '../auth/schema'

export const ownedThreads = sqliteTable(
  'owned_threads',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    sourceRevision: integer('source_revision').notNull().default(1),
    recordJson: text('record_json').notNull(),
    sourceText: text('source_text'),
    mutationId: text('mutation_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    unique().on(t.id, t.ownerId),
    index('owned_threads_owner').on(t.ownerId, t.id),
  ],
)
export const ownedPosts = sqliteTable(
  'owned_posts',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    ownerId: text('owner_id').notNull(),
    text: text('text').notNull(),
    position: integer('position').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    foreignKey({
      columns: [t.threadId, t.ownerId],
      foreignColumns: [ownedThreads.id, ownedThreads.ownerId],
    }).onDelete('cascade'),
    unique().on(t.id, t.threadId, t.ownerId),
    unique().on(t.threadId, t.position),
  ],
)
export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    postId: text('post_id').notNull(),
    ownerId: text('owner_id').notNull(),
    parentId: text('parent_id'),
    authorKind: text('author_kind', { enum: ['human', 'ai'] }).notNull(),
    authorId: text('author_id').notNull(),
    text: text('text').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: text('created_at').notNull(),
    turnId: text('turn_id'),
    passageIds: text('passage_ids').notNull().default('[]'),
  },
  (t) => [
    foreignKey({
      columns: [t.postId, t.threadId, t.ownerId],
      foreignColumns: [ownedPosts.id, ownedPosts.threadId, ownedPosts.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.parentId, t.threadId, t.postId, t.ownerId],
      foreignColumns: [t.id, t.threadId, t.postId, t.ownerId],
    }),
    unique().on(t.id, t.threadId, t.postId, t.ownerId),
    unique().on(t.threadId, t.sequence),
    index('comments_post').on(t.ownerId, t.threadId, t.postId, t.sequence),
  ],
)
export const readingProgress = sqliteTable(
  'reading_progress',
  {
    threadId: text('thread_id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    postId: text('post_id').notNull(),
    readAt: text('read_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.postId, t.threadId, t.ownerId],
      foreignColumns: [ownedPosts.id, ownedPosts.threadId, ownedPosts.ownerId],
    }).onDelete('cascade'),
  ],
)

export const sourcePassages = sqliteTable('source_passages', {
  id: text('id').notNull(), threadId: text('thread_id').notNull(), ownerId: text('owner_id').notNull(),
  sourceRevision: integer('source_revision').notNull(), start: integer('start_offset').notNull(), end: integer('end_offset').notNull(),
  text: text('text').notNull(),
}, t => [
  foreignKey({ columns: [t.threadId, t.ownerId], foreignColumns: [ownedThreads.id, ownedThreads.ownerId] }).onDelete('cascade'),
  unique().on(t.threadId, t.ownerId, t.sourceRevision, t.id),
])
export const guestIdentities = sqliteTable('guest_identities', {
  id: text('id').notNull(), threadId: text('thread_id').notNull(), ownerId: text('owner_id').notNull(),
  name: text('name').notNull(), handle: text('handle').notNull(), voice: text('voice').notNull(), version: integer('version').notNull(),
}, t => [
  foreignKey({ columns: [t.threadId, t.ownerId], foreignColumns: [ownedThreads.id, ownedThreads.ownerId] }).onDelete('cascade'),
  unique().on(t.threadId, t.ownerId, t.id),
])
