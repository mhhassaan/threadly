import migration from '../../drizzle/migrations/0001_auth.sql?raw'
import fenceMigration from '../../drizzle/migrations/0002_auth_fence.sql?raw'

import noticeMigration from '../../drizzle/migrations/0011_ai_processing_notice.sql?raw'

// Breakpoints delimit whole trigger bodies; never split a trigger on semicolons.
export async function applyMigration(db: D1Database, source: string) {
  const statements = source.includes('--> statement-breakpoint')
    ? source.split('--> statement-breakpoint')
    : source.replace(/^--.*$/gm, '').split(';')
  for (const statement of statements.map((x) => x.trim()).filter(Boolean))
    await db.prepare(statement).run()
}

export async function applyAuthMigrations(db: D1Database) {
  await applyMigration(db, migration)
  await applyMigration(db, fenceMigration)
  await applyMigration(db, noticeMigration)
}
