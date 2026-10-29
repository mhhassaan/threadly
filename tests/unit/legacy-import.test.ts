import { expect, test } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { createAccountBoundary } from '../../src/features/account/auth-state'
import { createAccountTransitions } from '../../src/features/account/account-transitions'

test('retrying a create with a lost response recovers only the identical owned thread', async () => {
  const { saveCloudDraft } = await import('../../src/features/account/library')
  const { vi } = await import('vitest')
  const id = crypto.randomUUID()
  const draft = {
    id,
    title: 'Draft',
    posts: ['My draft'],
    sourceUrl: '',
    source: null,
    media: [],
    interactions: {},
  }
  const snapshot = {
    thread: {
      id,
      ownerId: 'alice',
      revision: 1,
      sourceRevision: 1,
      record: draft,
      posts: [
        { id: crypto.randomUUID(), text: 'My draft', position: 0, revision: 1 },
      ],
    },
    comments: [],
    readPostId: null,
    readAt: null,
  }
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, input) =>
      input?.method === 'POST'
        ? Response.json({ code: 'REVISION_CONFLICT' }, { status: 409 })
        : Response.json(snapshot),
    )
  try {
    expect((await saveCloudDraft('alice', draft, null)).snapshot).toEqual(
      snapshot,
    )
    snapshot.thread.record = { ...draft, posts: ['Another device edited this'] }
    const stale = await saveCloudDraft('alice', draft, null)
    expect(stale.error?.status).toBe(409)
    expect(stale.draft).toBe(draft)
  } finally {
    network.mockRestore()
  }
})

test('remote logout immediately hides owner and fences unchanged sessions', async () => {
  const cache = new QueryClient(),
    boundary = createAccountBoundary(cache)
  let applied: string | null = null
  const transitions = createAccountTransitions(boundary, {
    applied: (id) => {
      applied = id
    },
    expired() {},
    broadcast() {},
  })
  transitions.apply('alice', 'session-a')
  cache.setQueryData(['account', 'alice', 'thread'], 'private')
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const remote = (
    transitions as typeof transitions & {
      remoteLogout: (id: string, refetch: () => Promise<void>) => Promise<void>
    }
  ).remoteLogout('alice', () => waiting)
  expect(applied).toBeNull()
  transitions.apply('alice', 'session-a')
  expect(applied).toBeNull()
  transitions.apply('bob', 'session-b')
  cache.setQueryData(['account', 'bob', 'thread'], 'bob private')
  finish()
  await remote
  expect(applied).toBe('bob')
  expect(cache.getQueryData(['account', 'alice', 'thread'])).toBeUndefined()
  expect(cache.getQueryData(['account', 'bob', 'thread'])).toBe('bob private')
})

test('offline session retains only the last confirmed owner while 401 expires it', async () => {
  const { resolveSessionUser } =
    await import('../../src/features/account/auth-state')
  const alice = { id: 'alice', name: 'Alice', verified: true }
  expect(resolveSessionUser(null, { status: 0 }, alice)).toEqual(alice)
  expect(resolveSessionUser(null, { status: 401 }, alice)).toBeNull()
  expect(resolveSessionUser(null, { status: 0 }, null)).toBeNull()
  expect(
    resolveSessionUser(
      { id: 'bob', name: 'Bob', emailVerified: true },
      null,
      alice,
    )?.id,
  ).toBe('bob')
})

test('guest_data_not_uploaded and durable migration key is account scoped', async () => {
  const { migrationKey, migrationIdFor } =
    await import('../../src/lib/legacy-import')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  const { vi } = await import('vitest')
  const network = vi.spyOn(globalThis, 'fetch')
  const first = migrationIdFor(storage, 'alice', 'local')
  expect(migrationIdFor(storage, 'alice', 'local')).toBe(first)
  expect(migrationIdFor(storage, 'bob', 'local')).not.toBe(first)
  expect(migrationKey('alice', 'local')).not.toContain('threadly-reader-')
  expect(network).not.toHaveBeenCalled()
  network.mockRestore()
})

test('stale_edit_retains_draft and offline write stays deliberate', async () => {
  const { saveCloudDraft } = await import('../../src/features/account/library')
  const draft = {
    id: crypto.randomUUID(),
    title: 'Draft',
    posts: ['My edit'],
    sourceUrl: '',
    source: null,
    media: [],
    interactions: {},
  }
  const { vi } = await import('vitest')
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json(
        { code: 'REVISION_CONFLICT', message: 'Changed' },
        { status: 409 },
      ),
    )
  const result = await saveCloudDraft('alice', draft, {
    thread: {
      id: draft.id,
      ownerId: 'alice',
      revision: 1,
      sourceRevision: 1,
      record: { ...draft, posts: ['Old'] },
      posts: [
        { id: crypto.randomUUID(), text: 'Old', position: 0, revision: 1 },
      ],
    },
    comments: [],
    readPostId: null,
    readAt: null,
  })
  expect(result.draft).toBe(draft)
  expect(result.error?.status).toBe(409)
  expect(result.snapshot).toBeNull()
  network.mockRejectedValue(new TypeError('offline'))
  const offline = await saveCloudDraft('alice', draft, null)
  expect(offline.draft).toBe(draft)
  expect(offline.error?.status).toBe(0)
  expect(network).toHaveBeenCalledTimes(2)
  network.mockRestore()
})

// Losing the base revision on focus would silently overwrite another device's edit.
test('cloud edit retains its starting revision and includes progress without duplicating comments', async () => {
  const { saveCloudDraft } = await import('../../src/features/account/library')
  const { toLegacyRecord } = await import('../../src/lib/legacy-import')
  const { vi } = await import('vitest')
  const id = crypto.randomUUID(),
    postId = crypto.randomUUID()
  const snapshot = {
    thread: {
      id,
      ownerId: 'alice',
      revision: 3,
      sourceRevision: 1,
      record: {
        id,
        title: 'Reading',
        posts: ['Original'],
        sourceUrl: '',
        source: null,
        media: [],
        interactions: {},
      },
      posts: [{ id: postId, text: 'Original', position: 0, revision: 1 }],
    },
    comments: [
      {
        id: crypto.randomUUID(),
        threadId: id,
        postId,
        parentId: null,
        authorKind: 'human' as const,
        authorId: 'alice',
        text: 'Saved comment',
        sequence: 1,
        createdAt: '2026-10-01',
        turnId: null,
        passageIds: [],
        usedMemoryIds: [],
      },
    ],
    readPostId: null,
    readAt: null,
  }
  const draft = toLegacyRecord(snapshot)
  draft.posts[0] = 'My edit'
  draft.interactions['0'].liked = true
  let payload: any
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, input) => {
      payload = JSON.parse(String(input?.body))
      return Response.json(snapshot)
    })
  try {
    await saveCloudDraft('alice', draft, snapshot, postId)
    expect(payload).toEqual({
      expectedRevision: 3,
      posts: [{ id: postId, text: 'My edit' }],
      interactions: { '0': { liked: true, replies: [] } },
      readPostId: postId,
    })
    const rejected = await saveCloudDraft('bob', draft, snapshot)
    expect(rejected.error?.status).toBe(403)
    expect(network).toHaveBeenCalledTimes(1)
    expect(snapshot.thread.record.posts).toEqual(['Original'])
    expect(snapshot.comments[0].text).toBe('Saved comment')
  } finally {
    network.mockRestore()
  }
})
