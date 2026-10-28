import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { applyAuthMigrations, applyMigration } from './migrations'
import reading from '../../drizzle/migrations/0003_reading.sql?raw'
import discussion from '../../drizzle/migrations/0005_discussion.sql?raw'

test('discussion rows require matching thread owner and cascade on deletion', async () => {
  const db = env.DB
  await applyAuthMigrations(db); await applyMigration(db, reading); await applyMigration(db, discussion)
  for (const id of ['alice', 'bob']) await db.prepare('INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').bind(id, id, `${id}@example.invalid`).run()
  await db.prepare("INSERT INTO owned_threads (id, owner_id, record_json, mutation_id, created_at, updated_at) VALUES ('thread', 'alice', '{}', 'm', 'now', 'now')").run()
  const passage = (owner: string) => db.prepare("INSERT INTO source_passages (id, thread_id, owner_id, source_revision, start_offset, end_offset, text) VALUES ('p0-1', 'thread', ?, 1, 0, 1, 'a')").bind(owner).run()
  const guest = (owner: string) => db.prepare("INSERT INTO guest_identities (id, thread_id, owner_id, name, handle, voice, version) VALUES ('guest', 'thread', ?, 'Echo', 'echo_ai', 'curious', 1)").bind(owner).run()
  await expect(passage('bob')).rejects.toThrow(); await expect(guest('bob')).rejects.toThrow()
  await passage('alice'); await guest('alice')
  await db.prepare("DELETE FROM owned_threads WHERE id = 'thread'").run()
  expect((await db.prepare('SELECT count(*) AS n FROM source_passages').first<{n: number}>())?.n).toBe(0)
  expect((await db.prepare('SELECT count(*) AS n FROM guest_identities').first<{n: number}>())?.n).toBe(0)
})
