import {
  ApiError,
  type MemoryItem,
  type UserContext,
} from '../../lib/account-thread'
import type { Platform } from '../platform'
import type { GenerationContext, MemoryContext } from './context'
import type { Exchange } from './contracts'
import { requireVerified } from '../data/threads'
import { getCast } from './cast'
import { getSettings } from '../data/settings'
import { uuid } from '../data/validation'

const regularIds = getCast('20000000-0000-4000-8000-000000000001')
  .filter((p) => p.kind === 'regular')
  .map((p) => p.id)
const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
type Row = {
  id: string
  persona_id: string
  text: string
  evidence_ids: string
  epoch: number
  created_at: string
}
const dto = (r: Row): MemoryContext => ({
  id: r.id,
  personaId: r.persona_id,
  text: r.text,
  evidenceIds: JSON.parse(r.evidence_ids),
  epoch: r.epoch,
})
// Missing/deleted/edited evidence invalidates the whole item. A reset cutoff is
// checked against evidence time, so copying an old quote cannot resurrect it.
const validMemory = `s.memory_enabled = 1 AND m.epoch = s.memory_epoch
 AND (SELECT count(*) FROM memory_evidence e JOIN comments c ON c.id = e.comment_id AND c.owner_id = m.owner_id
 JOIN owned_threads t ON t.id = c.thread_id AND t.owner_id = c.owner_id
 WHERE e.memory_id = m.id AND c.author_kind = 'human' AND c.text = m.text
 AND t.revision = e.thread_revision AND t.source_revision = e.source_revision
 AND (s.memory_reset_at IS NULL OR c.created_at > s.memory_reset_at)
 AND NOT EXISTS (SELECT 1 FROM memory_resets r WHERE r.owner_id = m.owner_id AND r.persona_id = m.persona_id AND c.created_at <= r.reset_at)) = json_array_length(m.evidence_ids)
 AND json_array_length(m.evidence_ids) = 1`

export async function getRelevantMemories(
  p: Platform,
  u: UserContext,
  input: { personaIds: string[]; text: string; limit: number },
): Promise<MemoryContext[]> {
  requireVerified(u)
  const ids = [
    ...new Set(input.personaIds.filter((id) => regularIds.includes(id))),
  ].slice(0, 4)
  const limit = Number.isSafeInteger(input.limit)
    ? Math.max(0, Math.min(input.limit, 4))
    : 0
  const query = words(input.text.slice(0, 12000))
  if (!ids.length || !limit || !query.size) return []
  if (!(await getSettings(p, u)).memoryEnabled) return []
  const rows = await p.db
    .prepare(
      `SELECT m.* FROM participant_memories m JOIN account_settings s ON s.owner_id = m.owner_id WHERE m.owner_id = ? AND m.persona_id IN (${ids.map(() => '?').join(',')}) AND ${validMemory} ORDER BY m.created_at DESC, m.id LIMIT 200`,
    )
    .bind(u.userId, ...ids)
    .all<Row>()
  return rows.results
    .map((r) => ({
      r,
      score: [...words(r.text)].filter((w) => query.has(w)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => dto(x.r))
}

export type InspectedMemory = MemoryItem
export async function inspectMemories(
  p: Platform,
  u: UserContext,
  ids: string[],
): Promise<InspectedMemory[]> {
  requireVerified(u)
  if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid memory IDs')
  ids.forEach(uuid)
  if (!(await getSettings(p, u)).memoryEnabled) return []
  const rows = await p.db
    .prepare(
      `SELECT m.* FROM participant_memories m JOIN account_settings s ON s.owner_id = m.owner_id WHERE m.owner_id = ? AND m.id IN (${ids.map(() => '?').join(',')}) AND ${validMemory} AND EXISTS (SELECT 1 FROM comments used, json_each(used.used_memory_ids) refs WHERE used.owner_id = m.owner_id AND used.author_kind = 'ai' AND used.author_id = m.persona_id AND refs.value = m.id)`,
    )
    .bind(u.userId, ...ids)
    .all<Row>()
  const result: InspectedMemory[] = []
  for (const row of rows.results) {
    const evidence = await p.db
      .prepare(
        `SELECT c.id, c.thread_id AS threadId, c.post_id AS postId, c.text, c.created_at AS createdAt FROM memory_evidence e JOIN comments c ON c.id = e.comment_id WHERE e.memory_id = ? AND c.owner_id = ?`,
      )
      .bind(row.id, u.userId)
      .all<InspectedMemory['evidence'][number]>()
    result.push({
      ...dto(row),
      createdAt: row.created_at,
      evidence: evidence.results,
    })
  }
  return result
}

// Internal factory: caller must place these statements between the successful
// DB-clock admission marker and its cleanup in the SAME D1 batch. No follow-up.
export function prepareMemoryUpdates(
  p: Platform,
  u: UserContext,
  turnId: string,
  context: GenerationContext,
  exchange: Exchange,
  marker: string,
): D1PreparedStatement[] {
  const updates = exchange.memoryUpdates
  const epoch = context.memoryEpoch
  requireVerified(u)
  if (
    updates.length > 2 ||
    updates.some(
      (m) =>
        !regularIds.includes(m.personaId) ||
        !context.allowedMemoryPersonaIds.includes(m.personaId) ||
        !exchange.comments.some((c) => c.speakerId === m.personaId) ||
        context.memoryEvidence[m.evidenceIds[0]] !== m.text ||
        !m.text.trim() ||
        m.text.length > 600 ||
        m.evidenceIds.length !== 1,
    )
  )
    throw new ApiError(422, 'INVALID_MEMORY', 'Invalid memory update')
  const statements: D1PreparedStatement[] = []
  for (const update of updates) {
    update.evidenceIds.forEach(uuid)
    const id = crypto.randomUUID()
    statements.push(
      p.db
        .prepare(
          `INSERT INTO participant_memories (id, owner_id, persona_id, text, evidence_ids, epoch, created_at, turn_id)
      SELECT ?, s.owner_id, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), a.id FROM account_settings s JOIN ai_turns a ON a.owner_id = s.owner_id JOIN comments c ON c.id = ? AND c.owner_id = s.owner_id
      WHERE s.owner_id = ? AND s.memory_enabled = 1 AND s.memory_epoch = ? AND a.id = ? AND a.status = 'complete' AND a.error_code = ? AND a.memory_epoch = s.memory_epoch
      AND c.thread_id = a.thread_id AND c.author_kind = 'human' AND c.text = ?
      AND (s.memory_reset_at IS NULL OR c.created_at > s.memory_reset_at)
      AND NOT EXISTS (SELECT 1 FROM memory_resets r WHERE r.owner_id = s.owner_id AND r.persona_id = ? AND c.created_at <= r.reset_at)
      ON CONFLICT(owner_id, persona_id, epoch, text, evidence_ids) DO NOTHING`,
        )
        .bind(
          id,
          update.personaId,
          update.text,
          JSON.stringify(update.evidenceIds),
          epoch,
          update.evidenceIds[0],
          u.userId,
          epoch,
          turnId,
          marker,
          update.text,
          update.personaId,
        ),
    )
    statements.push(
      p.db
        .prepare(
          `INSERT INTO memory_evidence (memory_id, comment_id, thread_revision, source_revision) SELECT m.id, c.id, t.revision, t.source_revision FROM participant_memories m JOIN comments c ON c.id = ? AND c.owner_id = m.owner_id JOIN owned_threads t ON t.id = c.thread_id AND t.owner_id = c.owner_id WHERE m.id = ? AND m.owner_id = ?`,
        )
        .bind(update.evidenceIds[0], id, u.userId),
    )
  }
  return statements
}
// Revalidate context evidence at atomic publication, including other threads.
export function memoryPublicationCheck(
  u: UserContext,
  memories: MemoryContext[],
): { sql: string; bindings: (string | number)[] } {
  if (!memories.length) return { sql: '1', bindings: [] }
  return {
    sql: `(SELECT count(*) FROM participant_memories m JOIN account_settings s ON s.owner_id = m.owner_id WHERE m.owner_id = ? AND m.id IN (${memories.map(() => '?').join(',')}) AND ${validMemory}) = ?`,
    bindings: [u.userId, ...memories.map((m) => m.id), memories.length],
  }
}
