import { buildContext } from '../../src/server/discussion/context'
import { getCast } from '../../src/server/discussion/cast'
export { validateExchange } from '../../src/server/discussion/contracts'
import type { ThreadSnapshot } from '../../src/lib/account-thread'

export function publicFixtures() {
  const cases = [
    [
      'sarcasm',
      'Great, a battery that stores sunshine. What will they think of next?',
    ],
    ['factual correction', 'These panels must work equally well at midnight.'],
    ['anger', 'This storage argument is infuriating. Nobody is listening.'],
    ['ambiguity', 'Sure, unlimited free energy sounds perfectly normal.'],
    [
      'agreement and disagreement',
      'I agree storage costs matter. I disagree that this makes solar useless.',
    ],
    [
      'concession',
      'You are right: the source does not establish that stronger claim.',
    ],
    ['source misinformation', 'Does the article support this stronger claim?'],
    [
      'memory accuracy',
      'Can you connect solar storage evidence to our earlier discussion?',
    ],
  ]
  return cases.map(([rubric, text], index) => {
    const threadId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const postId = '30000000-0000-4000-8000-000000000001'
    const humanId = '40000000-0000-4000-8000-000000000001'
    const sourceText =
      rubric === 'source misinformation'
        ? 'The synthetic article claims one small panel can power the entire planet.'
        : 'Solar panels produce electricity in daylight. Storage has costs.'
    const cast = getCast(threadId)
    const snapshot: ThreadSnapshot = {
      thread: {
        id: threadId,
        ownerId: 'synthetic-owner',
        revision: 1,
        sourceRevision: 1,
        record: {
          id: threadId,
          title: 'Public synthetic solar reading',
          sourceText,
          posts: ['Solar storage evidence.'],
          sourceUrl: '',
          source: null,
          media: [],
          interactions: {},
        },
        posts: [
          {
            id: postId,
            text: 'Solar storage evidence.',
            position: 0,
            revision: 1,
          },
        ],
      },
      comments: [
        {
          id: humanId,
          threadId,
          postId,
          parentId: null,
          authorKind: 'human',
          authorId: 'synthetic-owner',
          text,
          sequence: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          turnId: null,
          passageIds: [],
          usedMemoryIds: [],
        },
      ],
      readPostId: null,
      readAt: null,
    }
    const memory =
      rubric === 'memory accuracy'
        ? [
            {
              id: '50000000-0000-4000-8000-000000000001',
              personaId: cast[0].id,
              text: 'I prefer evidence about solar storage.',
              evidenceIds: ['60000000-0000-4000-8000-000000000001'],
              epoch: 1,
            },
          ]
        : []
    return {
      rubric,
      context: buildContext(
        snapshot,
        {
          requestId: crypto.randomUUID(),
          threadId,
          kind: 'reply',
          triggerCommentId: humanId,
        },
        memory,
        cast,
        { memoryEpoch: 1, memoryEnabled: true },
      ),
    }
  })
}
