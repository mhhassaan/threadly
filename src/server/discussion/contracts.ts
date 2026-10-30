import { ApiError } from '../../lib/account-thread'
import type { GenerationContext } from './context'

export type ExchangeComment = {
  id: string
  speakerId: string
  postId: string
  parentId: string | null
  batchParentId: string | null
  text: string
  passageIds: string[]
}
export type MemoryUpdate = {
  personaId: string
  text: string
  evidenceIds: string[]
}
export type Exchange = {
  comments: ExchangeComment[]
  memoryUpdates: MemoryUpdate[]
}
export const exchangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['comments', 'memoryUpdates'],
  properties: {
    memoryUpdates: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['personaId', 'text', 'evidenceIds'],
        properties: {
          personaId: { type: 'string' },
          text: { type: 'string', minLength: 1, maxLength: 600 },
          evidenceIds: {
            type: 'array',
            minItems: 1,
            maxItems: 1,
            items: { type: 'string' },
          },
        },
      },
    },
    comments: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'speakerId',
          'postId',
          'parentId',
          'batchParentId',
          'text',
          'passageIds',
        ],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' },
          speakerId: { type: 'string' },
          postId: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          batchParentId: { type: ['string', 'null'] },
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          passageIds: {
            type: 'array',
            maxItems: 24,
            uniqueItems: true,
            items: { type: 'string' },
          },
        },
      },
    },
  },
} as const
function invalid(): never {
  throw new ApiError(
    422,
    'INVALID_EXCHANGE',
    'The AI response did not match the discussion contract',
  )
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const obj = value as Record<string, unknown>
  if (
    Object.keys(obj).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(obj, k))
  )
    invalid()
  return obj
}
function member(value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid()
  return value
}

// Provider JSON is untrusted. This does not establish factual entailment: actual
// model samples require human review. It validates only the authorized structure.
export function validateExchange(
  raw: unknown,
  context: GenerationContext,
): Exchange {
  const root = object(raw, ['comments', 'memoryUpdates'])
  if (!Array.isArray(root.comments)) invalid()
  const maxComments =
    context.kind === 'reply' ? 3 : context.totalPostCount === 1 ? 1 : 4
  if (
    root.comments.length > maxComments ||
    (context.kind === 'reply' && !root.comments.length)
  )
    invalid()
  const result: ExchangeComment[] = []
  const seen = new Map<string, ExchangeComment>()
  for (const value of root.comments) {
    const c = object(value, [
      'id',
      'speakerId',
      'postId',
      'parentId',
      'batchParentId',
      'text',
      'passageIds',
    ])
    if (
      typeof c.id !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(c.id) ||
      seen.has(c.id) ||
      context.allowedParentIds.includes(c.id)
    )
      invalid()
    const speakerId = member(c.speakerId, context.allowedSpeakerIds)
    const postId = member(c.postId, context.allowedPostIds)
    if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 2000)
      invalid()
    if (
      !Array.isArray(c.passageIds) ||
      c.passageIds.length > 24 ||
      new Set(c.passageIds).size !== c.passageIds.length
    )
      invalid()
    const passageIds = c.passageIds.map((id) =>
      member(id, context.allowedPassageIds),
    )
    if (c.parentId !== null && c.batchParentId !== null) invalid()
    let parentId: string | null = null
    let batchParentId: string | null = null
    if (c.parentId !== null) {
      parentId = member(c.parentId, context.allowedParentIds)
      if (context.parentPostIds[parentId] !== postId) invalid()
    }
    if (c.batchParentId !== null) {
      if (typeof c.batchParentId !== 'string') invalid()
      const parent = seen.get(c.batchParentId)
      if (!parent || parent.postId !== postId) invalid()
      batchParentId = c.batchParentId
    }
    if (
      context.kind === 'reply' &&
      !result.length &&
      parentId !== context.triggerCommentId
    )
      invalid()
    const comment = {
      id: c.id,
      speakerId,
      postId,
      parentId,
      batchParentId,
      text: c.text,
      passageIds,
    }
    result.push(comment)
    seen.set(comment.id, comment)
  }
  const posts = new Set(result.map((c) => c.postId))
  const speakers = new Set(result.map((c) => c.speakerId))
  if (speakers.size > (context.kind === 'reply' ? 2 : 4)) invalid()
  if (
    context.kind === 'opening' &&
    (posts.size > 3 ||
      (context.totalPostCount > 1 && posts.size >= context.totalPostCount))
  )
    invalid()
  if (!Array.isArray(root.memoryUpdates) || root.memoryUpdates.length > 2)
    invalid()
  const memoryUpdates: MemoryUpdate[] = root.memoryUpdates.map((value) => {
    const m = object(value, ['personaId', 'text', 'evidenceIds'])
    const personaId = member(m.personaId, context.allowedMemoryPersonaIds)
    if (
      !speakers.has(personaId) ||
      typeof m.text !== 'string' ||
      !m.text.trim() ||
      m.text.length > 600 ||
      !Array.isArray(m.evidenceIds) ||
      m.evidenceIds.length !== 1
    )
      invalid()
    const evidenceId = member(
      m.evidenceIds[0],
      Object.keys(context.memoryEvidence),
    )
    // Whole human-authored quotes only: no summaries, inferred traits or invented
    // sensitive profiles. This proves provenance, never the truth of the quote.
    if (context.memoryEvidence[evidenceId] !== m.text) invalid()
    return { personaId, text: m.text, evidenceIds: [evidenceId] }
  })
  // Structural/field and transport bounds protect parsing. Provider max_tokens
  // enforces the 1200-token budget; UTF-8 bytes are NOT a token measurement.
  if (
    new TextEncoder().encode(
      JSON.stringify({ comments: result, memoryUpdates }),
    ).byteLength > 24000
  )
    invalid()
  return { comments: result, memoryUpdates }
}
