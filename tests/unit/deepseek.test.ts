import { afterEach, expect, test, vi } from 'vitest'
import { callDeepSeek } from '../../src/server/discussion/deepseek'
import type { Platform } from '../../src/server/platform'
import type { GenerationContext } from '../../src/server/discussion/context'

const p = { env: { deepseekApiKey: 'test-key' } } as Platform
const context = {
  messages: [{ role: 'system', content: 'Return JSON.' }],
  inputTokenUpperBound: 2085,
} as GenerationContext
const good = () =>
  Response.json({
    choices: [
      { finish_reason: 'stop', message: { content: '{"comments":[]}' } },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  })
afterEach(() => vi.unstubAllGlobals())
test.each(['503', 'network'])(
  'transient_%s_retries_once_then_publishes_validated_payload',
  async (failure) => {
    const fetcher = vi.fn()
    if (failure === '503')
      fetcher.mockResolvedValueOnce(new Response('', { status: 503 }))
    else
      fetcher.mockRejectedValueOnce(new TypeError('Synthetic network failure'))
    fetcher.mockResolvedValueOnce(good())
    vi.stubGlobal('fetch', fetcher)
    expect(
      (await callDeepSeek(p, context, new AbortController().signal)).exchange,
    ).toEqual({ comments: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)
test.each(['503', 'network'])(
  'persistent_%s_stops_after_one_retry',
  async (failure) => {
    const fetcher =
      failure === '503'
        ? vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(new Response('', { status: 503 })),
            )
        : vi.fn().mockRejectedValue(new TypeError('Synthetic network failure'))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      callDeepSeek(p, context, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  },
)
test('transient_429_retries_once_and_uses_bounded_json_request', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(good())
  vi.stubGlobal('fetch', fetcher)
  const result = await callDeepSeek(p, context, new AbortController().signal)
  expect(result.exchange).toEqual({ comments: [] })
  expect(fetcher).toHaveBeenCalledTimes(2)
  const body = JSON.parse(fetcher.mock.calls[0][1].body)
  expect(body).toMatchObject({
    model: 'deepseek-flash',
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
  })
})
test('authentication_error_is_not_retried', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(
    callDeepSeek(p, context, new AbortController().signal),
  ).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
test.each(['', '{', '{"comments":[] }'])(
  'empty_invalid_or_truncated_response_fails_without_retry',
  async (content) => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: content.startsWith('{"comments"')
              ? 'length'
              : 'stop',
            message: { content },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(
      callDeepSeek(p, context, new AbortController().signal),
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  },
)

test('abort_stops_provider_work', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      ),
  )
  vi.stubGlobal('fetch', fetcher)
  const result = callDeepSeek(p, context, controller.signal)
  controller.abort()
  await expect(result).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
test('timeout_stops_provider_work', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      ),
  )
  vi.stubGlobal('fetch', fetcher)
  const result = callDeepSeek(p, context, new AbortController().signal)
  const rejected = expect(result).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
})

test.each(['body', 'content', 'reported_tokens'])(
  'oversize_provider_%s_fails_without_retry',
  async (mode) => {
    const payload: any = await good().json()
    if (mode === 'body') payload.padding = 'x'.repeat(66000)
    if (mode === 'content')
      payload.choices[0].message.content = JSON.stringify({
        comments: [{ text: 'x'.repeat(24000) }],
      })
    if (mode === 'reported_tokens') payload.usage.completion_tokens = 1201
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      callDeepSeek(p, context, new AbortController().signal),
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  },
)

import { publicFixtures } from '../fixtures/ai-evaluation'
import { validateExchange } from '../../src/server/discussion/contracts'
import { estimateInputTokens } from '../../src/server/discussion/context'

test('real_builder_contract_examples_and_metadata_reach_provider_unchanged_within_budget', async () => {
  const built = publicFixtures()[1].context
  let transmitted: any
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    transmitted = JSON.parse(init.body as string)
    return good()
  })
  await callDeepSeek(p, built, new AbortController().signal)
  expect(transmitted.messages).toEqual(built.messages)
  const examples = JSON.parse(transmitted.messages[1].content).contractExamples
  expect(examples).toBeDefined()
  expect(validateExchange(examples.valid, built)).toEqual(examples.valid)
  expect(examples.valid.comments[0].passageIds).toEqual(['p0-64'])
  expect(built.inputTokenUpperBound).toBe(
    estimateInputTokens(transmitted.messages),
  )
  expect(
    new TextEncoder().encode(JSON.stringify(transmitted)).byteLength + 2048,
  ).toBeLessThanOrEqual(12000)
  expect(transmitted.max_tokens).toBe(1200)
})
