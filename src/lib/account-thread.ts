import type { Reaction, ThreadRecord } from './thread'

export type UserContext = {
  userId: string
  email: string
  name: string
  verified: boolean
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type OwnedPost = {
  id: string
  text: string
  position: number
  revision: number
}
export type OwnedThread = {
  id: string
  ownerId: string
  revision: number
  sourceRevision: number
  record: ThreadRecord
  posts: OwnedPost[]
}
export type Comment = {
  id: string
  threadId: string
  postId: string
  parentId: string | null
  authorKind: 'human' | 'ai'
  authorId: string
  text: string
  sequence: number
  createdAt: string
  turnId: string | null
  passageIds: string[]
  usedMemoryIds: string[]
}
export type AppendCommentInput = {
  id: string
  threadId: string
  postId: string
  parentId: string | null
  text: string
}
export type ThreadSnapshot = {
  openingBlocked?: boolean
  thread: OwnedThread
  comments: Comment[]
  isImported?: boolean
  readPostId: string | null
  readAt: string | null
}
export type CreateThreadInput = { record: ThreadRecord }
export type PatchThreadInput = {
  expectedRevision: number
  posts?: { id: string; text: string }[]
  interactions?: Record<string, Reaction>
  readPostId?: string
}
export type LibraryPage = { threads: OwnedThread[]; nextCursor: string | null }

export type AccountSettings = {
  aiEnabled: boolean
  memoryEnabled: boolean
  consentAt: string | null
  memoryEpoch: number
}
export type TurnInput = {
  requestId: string
  threadId: string
  kind: 'opening' | 'reply'
  triggerCommentId: string | null
}
export type TurnState = {
  id: string
  status: 'reserved' | 'running' | 'complete' | 'failed' | 'cancelled' | 'stale'
  commentIds: string[]
  errorCode?: string
}
export type LogicalTurnStatus = { turn: TurnState | null; cancelled: boolean }
export type AiUsageStatus = {
  utcDay: string
  opening: { limit: number; remaining: number }
  reply: { limit: number; remaining: number }
  availability: 'available' | 'paused' | 'unavailable' | 'busy'
}

export type MemoryItem = {
  id: string
  personaId: string
  text: string
  evidenceIds: string[]
  epoch: number
  createdAt: string
  evidence: {
    id: string
    threadId: string
    postId: string
    text: string
    createdAt: string
  }[]
}
