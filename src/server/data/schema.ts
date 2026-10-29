import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  unique,
  uniqueIndex,
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
    usedMemoryIds: text('used_memory_ids').notNull().default('[]'),
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

export const sourcePassages = sqliteTable(
  'source_passages',
  {
    id: text('id').notNull(),
    threadId: text('thread_id').notNull(),
    ownerId: text('owner_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    start: integer('start_offset').notNull(),
    end: integer('end_offset').notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.threadId, t.ownerId],
      foreignColumns: [ownedThreads.id, ownedThreads.ownerId],
    }).onDelete('cascade'),
    unique().on(t.threadId, t.ownerId, t.sourceRevision, t.id),
  ],
)
export const guestIdentities = sqliteTable(
  'guest_identities',
  {
    id: text('id').notNull(),
    threadId: text('thread_id').notNull(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    voice: text('voice').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.threadId, t.ownerId],
      foreignColumns: [ownedThreads.id, ownedThreads.ownerId],
    }).onDelete('cascade'),
    unique().on(t.threadId, t.ownerId, t.id),
  ],
)

export const accountSettings = sqliteTable('account_settings', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  aiEnabled: integer('ai_enabled').notNull().default(0),
  memoryEnabled: integer('memory_enabled').notNull().default(0),
  consentAt: text('consent_at'),
  memoryEpoch: integer('memory_epoch').notNull().default(0),
  memoryResetAt: text('memory_reset_at'),
  settingsEpoch: integer('settings_epoch').notNull().default(0),
})
export const aiRequests = sqliteTable(
  'ai_requests',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    threadId: text('thread_id').notNull(),
    kind: text('kind').notNull(),
    triggerCommentId: text('trigger_comment_id'),
    sourceRevision: integer('source_revision').notNull(),
    utcDay: text('utc_day').notNull(),
  },
  (t) => [
    unique().on(t.ownerId, t.requestId),
    unique().on(t.id, t.ownerId),
    uniqueIndex('ai_one_opening')
      .on(t.threadId, t.ownerId, t.sourceRevision)
      .where(sql`${t.kind} = 'opening'`),
    foreignKey({
      columns: [t.threadId, t.ownerId],
      foreignColumns: [ownedThreads.id, ownedThreads.ownerId],
    }).onDelete('cascade'),
  ],
)
export const aiTurns = sqliteTable(
  'ai_turns',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    ownerId: text('owner_id').notNull(),
    threadId: text('thread_id').notNull(),
    status: text('status').notNull(),
    leaseUntil: text('lease_until').notNull(),
    threadRevision: integer('thread_revision').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    settingsEpoch: integer('settings_epoch').notNull(),
    memoryEpoch: integer('memory_epoch').notNull(),
    createdAt: text('created_at').notNull(),
    errorCode: text('error_code'),
  },
  (t) => [
    unique().on(t.id, t.ownerId),
    uniqueIndex('ai_one_active_thread')
      .on(t.threadId, t.ownerId)
      .where(sql`${t.status} IN ('reserved','running')`),
    foreignKey({
      columns: [t.requestId, t.ownerId],
      foreignColumns: [aiRequests.id, aiRequests.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.threadId, t.ownerId],
      foreignColumns: [ownedThreads.id, ownedThreads.ownerId],
    }).onDelete('cascade'),
  ],
)
export const aiAllowances = sqliteTable('ai_allowances', {
  requestId: text('request_id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  utcDay: text('utc_day').notNull(),
  kind: text('kind').notNull(),
})
export const aiUsage = sqliteTable('ai_usage', {
  turnId: text('turn_id').primaryKey(),
  ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
  utcDay: text('utc_day').notNull(),
  reservedMicros: integer('reserved_micros').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCostMicros: integer('estimated_cost_micros'),
})

export const memoryResets = sqliteTable(
  'memory_resets',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    personaId: text('persona_id').notNull(),
    resetAt: text('reset_at').notNull(),
  },
  (t) => [unique().on(t.ownerId, t.personaId)],
)
export const participantMemories = sqliteTable(
  'participant_memories',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    personaId: text('persona_id').notNull(),
    text: text('text').notNull(),
    evidenceIds: text('evidence_ids').notNull(),
    epoch: integer('epoch').notNull(),
    createdAt: text('created_at').notNull(),
    turnId: text('turn_id').notNull(),
  },
  (t) => [
    unique().on(t.ownerId, t.personaId, t.epoch, t.text, t.evidenceIds),
    index('memory_owner_persona').on(t.ownerId, t.personaId, t.epoch),
  ],
)
export const memoryEvidence = sqliteTable(
  'memory_evidence',
  {
    memoryId: text('memory_id')
      .notNull()
      .references(() => participantMemories.id, { onDelete: 'cascade' }),
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    threadRevision: integer('thread_revision').notNull(),
    sourceRevision: integer('source_revision').notNull(),
  },
  (t) => [unique().on(t.memoryId, t.commentId)],
)
