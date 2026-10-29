import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import {
  createDiscussionController,
  type DiscussionRequest,
} from '../../src/features/discussion/useDiscussion'
import { CommentItem } from '../../src/features/discussion/CommentItem'
import { createReplyComposer } from '../../src/features/account/reply-composer'
const settings = {
  aiEnabled: true,
  memoryEnabled: false,
  consentAt: 'now',
  memoryEpoch: 0,
}
const input = {
  id: 'human-id',
  threadId: 'thread',
  postId: 'post',
  parentId: 'ai-parent',
  text: 'Follow up',
}
const human = {
  ...input,
  authorKind: 'human',
  authorId: 'alice',
  sequence: 1,
  createdAt: '',
  turnId: null,
  passageIds: [],
}
const complete = { id: 'attempt', status: 'complete', commentIds: [] }
function setup(
  request: ReturnType<typeof vi.fn<DiscussionRequest>> = vi.fn(
    async (path: string) => (path === '/api/comments' ? human : complete),
  ),
) {
  const saved = vi.fn()
  const controller = createDiscussionController({
    owner: 'alice',
    threadId: 'thread',
    request,
    saved,
    settings: () => settings,
  })
  return { controller, request, saved }
}
test('comment_saved_before_ai', async () => {
  let finish!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>((path: string) =>
    path === '/api/comments'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(complete),
  )
  const { controller, saved } = setup(request)
  const promise = controller.submit(input)
  expect(request.mock.calls.map((c) => c[0])).toEqual(['/api/comments'])
  finish(human)
  expect(await promise).toBe(true)
  await Promise.resolve()
  expect(saved).toHaveBeenCalledWith(human)
  expect(request.mock.calls.map((c) => c[0])).toEqual([
    '/api/comments',
    '/api/ai/turns',
  ])
})
test('reply_to_ai_keeps_parent', async () => {
  const { controller, request } = setup()
  await controller.submit(input)
  expect(request.mock.calls[0][2]).toEqual(input)
})
test('no_consent_no_provider', async () => {
  const request = vi.fn(async () => human)
  const controller = createDiscussionController({
    owner: 'alice',
    threadId: 'thread',
    request,
    saved() {},
    settings: () => ({ ...settings, consentAt: null }),
  })
  await controller.submit(input)
  await controller.generate({
    requestId: 'opening',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  expect(request.mock.calls).toHaveLength(1)
})
test('account_switch_aborts_display', async () => {
  let finish!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { controller, saved } = setup(request)
  const promise = controller.submit(input)
  const signal = request.mock.calls[0][3] as AbortSignal
  controller.dispose()
  expect(signal.aborted).toBe(true)
  finish(human)
  expect(await promise).toBe(false)
  expect(saved).not.toHaveBeenCalled()
})
test('expired_session_preserves_draft', async () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
  }
  const { controller } = setup(
    vi.fn(async () => {
      throw Error('Sign in again')
    }),
  )
  const composer = createReplyComposer(
    (text) => controller.submit({ ...input, text }),
    'alice-draft',
    storage,
  )
  composer.change('Keep this')
  expect(await composer.submit()).toBe(false)
  expect(
    createReplyComposer(() => {}, 'alice-draft', storage).snapshot().value,
  ).toBe('Keep this')
})
test('ai_label_always_visible', () => {
  const markup = renderToStaticMarkup(
    createElement(CommentItem, {
      comment: {
        ...human,
        id: 'ai',
        authorKind: 'ai',
        authorId: '10000000-0000-4000-8000-000000000001',
      },
      name: 'Flint',
      onReply() {},
      sourceText: '',
      parent: null,
    }),
  )
  expect(markup).toContain('Flint')
  expect(markup).toContain('>AI</span>')
})

test('cancel_confirmation_uses_server_terminal_state_and_complete_wins', async () => {
  let finish!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>((path, method) =>
    method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({ turn: complete, cancelled: false }),
  )
  const { controller, saved } = setup(request)
  const running = controller.generate({
    requestId: 'logical',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  await controller.cancel()
  expect(controller.snapshot().turn?.status).toBe('complete')
  expect(controller.snapshot().pending).toBe(false)
  expect(controller.snapshot().error).toBe('')
  expect(saved).toHaveBeenCalled()
  finish({ ...complete, status: 'cancelled' })
  await running
  expect(controller.snapshot().turn?.status).toBe('complete')
})
test('retry_reuses_logical_id_and_readonly_status_does_not_generate', async () => {
  const request = vi.fn<DiscussionRequest>(async (_path, method) =>
    method === 'POST'
      ? { ...complete, status: 'failed' }
      : { turn: complete, cancelled: false },
  )
  const { controller } = setup(request)
  const turn = {
    requestId: 'logical',
    threadId: 'thread',
    kind: 'opening' as const,
    triggerCommentId: null,
  }
  await controller.generate(turn)
  await controller.retry('logical')
  expect(
    request.mock.calls.filter((c) => c[1] === 'POST').map((c) => c[2]),
  ).toEqual([turn, turn])
  await controller.refresh()
  expect(request).toHaveBeenCalledTimes(2)
})
test('failed_cancel_does_not_claim_cancellation', async () => {
  let finish!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>((_path, method) =>
    method === 'POST'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.reject(Error('Offline')),
  )
  const { controller } = setup(request)
  const running = controller.generate({
    requestId: 'logical',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  await controller.cancel()
  expect(controller.snapshot().pending).toBe(true)
  expect(controller.snapshot().error).toBe('Offline')
  finish(complete)
  await running
})

test('effect_replay_reactivates_controller_but_fences_old_submission', async () => {
  let finish!: (v: unknown) => void
  const request = vi
    .fn<DiscussionRequest>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(human)
  const { controller, saved } = setup(request)
  const old = controller.submit(input)
  controller.dispose()
  controller.activate()
  finish(human)
  expect(await old).toBe(false)
  expect(saved).not.toHaveBeenCalled()
  expect(await controller.submit(input)).toBe(true)
})

test('provider_failure_after_saved_comment_clears_composer_and_retry_does_not_resubmit_human', async () => {
  const request = vi.fn<DiscussionRequest>(async (path) => {
    if (path === '/api/comments') return human
    throw Error('AI unavailable')
  })
  const { controller } = setup(request)
  const composer = createReplyComposer((text) =>
    controller.submit({ ...input, text }),
  )
  composer.change('Already saved')
  expect(await composer.submit()).toBe(true)
  expect(composer.snapshot().value).toBe('')
  await controller.retry(controller.snapshot().input!.requestId)
  expect(
    request.mock.calls.filter((c) => c[0] === '/api/comments'),
  ).toHaveLength(1)
  expect(
    request.mock.calls.filter((c) => c[0] === '/api/ai/turns'),
  ).toHaveLength(2)
})
test('opening_requires_creation_intent_origin_flag_and_consent', async () => {
  const { shouldOpenDiscussion } =
    await import('../../src/features/discussion/ConsentNotice')
  const snapshot = {
    isImported: false,
  } as import('../../src/lib/account-thread').ThreadSnapshot
  expect(shouldOpenDiscussion(true, snapshot, settings)).toBe(true)
  expect(shouldOpenDiscussion(false, snapshot, settings)).toBe(false)
  expect(
    shouldOpenDiscussion(true, { ...snapshot, isImported: true }, settings),
  ).toBe(false)
  expect(
    shouldOpenDiscussion(
      true,
      { ...snapshot, isImported: undefined },
      settings,
    ),
  ).toBe(false)
  expect(
    shouldOpenDiscussion(true, snapshot, { ...settings, consentAt: null }),
  ).toBe(false)
  expect(
    shouldOpenDiscussion(true, snapshot, { ...settings, aiEnabled: false }),
  ).toBe(false)
})

test('late_pending_poll_cannot_reopen_completed_turn', async () => {
  let finishPost!: (v: unknown) => void, finishGet!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>(
    (_path, method) =>
      new Promise((resolve) => {
        if (method === 'POST') finishPost = resolve
        else finishGet = resolve
      }),
  )
  const { controller } = setup(request)
  const running = controller.generate({
    requestId: 'logical',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  const polling = controller.refresh()
  finishPost(complete)
  await running
  finishGet({ turn: { ...complete, status: 'running' }, cancelled: false })
  await polling
  expect(controller.snapshot().turn?.status).toBe('complete')
  expect(controller.snapshot().pending).toBe(false)
})
test('old_cancel_after_effect_replay_cannot_overwrite_new_turn', async () => {
  let finishCancel!: (v: unknown) => void
  const request = vi.fn<DiscussionRequest>((_path, method) =>
    method === 'DELETE'
      ? new Promise((resolve) => {
          finishCancel = resolve
        })
      : Promise.resolve({ ...complete, status: 'running' }),
  )
  const { controller } = setup(request)
  await controller.generate({
    requestId: 'old',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  const cancelling = controller.cancel()
  controller.dispose()
  controller.activate()
  await controller.generate({
    requestId: 'new',
    threadId: 'thread',
    kind: 'opening',
    triggerCommentId: null,
  })
  finishCancel({ turn: { ...complete, status: 'cancelled' }, cancelled: true })
  await cancelling
  expect(controller.snapshot().input?.requestId).toBe('new')
  expect(controller.snapshot().pending).toBe(true)
})

test('new_creation_intent_moves_to_one_reader_and_cannot_restart_on_parent_reopen', async () => {
  const { moveOpeningIntent } =
    await import('../../src/features/discussion/ConsentNotice')
  const make = () => {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value)
      },
      removeItem: (key: string) => {
        data.delete(key)
      },
    }
  }
  const parent = make(),
    reader = make(),
    revisit = make()
  parent.setItem('opening', 'new')
  moveOpeningIntent(parent, reader, 'opening')
  expect(parent.getItem('opening')).toBeNull()
  expect(reader.getItem('opening')).toBe('new')
  reader.removeItem('opening')
  moveOpeningIntent(parent, revisit, 'opening')
  expect(revisit.getItem('opening')).toBeNull()
})
