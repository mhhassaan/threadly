import { inject } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { sql } from 'drizzle-orm'

export async function readTestRow(db: D1Database) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS platform_fixture (value TEXT NOT NULL)',
  )
  await db
    .prepare('INSERT INTO platform_fixture (value) VALUES (?)')
    .bind('local')
    .run()
  const row = await drizzle(db).get<{ value: string }>(
    sql`SELECT value FROM platform_fixture LIMIT 1`,
  )
  return row?.value
}

export const privateUrlInput: RequestInit = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
}

export function fetchApp(path: string, init?: RequestInit) {
  return fetch(new URL(path, inject('appUrl')), init)
}
