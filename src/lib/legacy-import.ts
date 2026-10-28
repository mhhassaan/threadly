import type { ThreadSnapshot } from './account-thread'
import type { ThreadRecord } from './thread'

export const migrationKey = (owner: string, localId: string) =>
  `threadly-account:${encodeURIComponent(owner)}:import:${encodeURIComponent(localId)}`
export function migrationIdFor(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  owner: string,
  localId: string,
): string {
  const key = migrationKey(owner, localId),
    previous = storage.getItem(key)
  if (previous) return previous
  const id = crypto.randomUUID()
  // Persist before the request; an interrupted response can safely be resumed.
  storage.setItem(key, id)
  return id
}
export function toLegacyRecord(snapshot: ThreadSnapshot): ThreadRecord {
  const record = structuredClone(snapshot.thread.record)
  for (const comment of snapshot.comments) {
    const position = snapshot.thread.posts.find(
      (p) => p.id === comment.postId,
    )?.position
    if (position === undefined) continue
    const reaction = record.interactions[position] ?? { replies: [] }
    record.interactions[position] = {
      ...reaction,
      replies: [
        ...reaction.replies,
        { text: comment.text, date: comment.createdAt },
      ],
    }
  }
  return record
}
