import { ApiError } from '../../lib/account-thread'
import type { Platform } from '../platform'
import type { GenerationContext } from './context'
import type { ProviderUsage } from './turns'

const failure = () =>
  new ApiError(
    503,
    'AI_PROVIDER_FAILED',
    'AI generation is temporarily unavailable',
  )

/** A single bounded provider operation, including its optional transient retry. */
export async function callDeepSeek(
  p: Platform,
  context: GenerationContext,
  signal: AbortSignal,
): Promise<{ exchange: unknown; usage: ProviderUsage }> {
  if (!p.env.deepseekApiKey) throw failure()
  const body = JSON.stringify({
    model: 'deepseek-flash',
    messages: context.messages,
    response_format: { type: 'json_object' },
    max_tokens: 1200,
    thinking: { type: 'disabled' },
    stream: false,
  })
  // UTF-8 bytes bound byte-fallback tokenization; 2048 covers transport framing.
  if (new TextEncoder().encode(body).byteLength + 2048 > 12000)
    throw new ApiError(
      422,
      'CONTEXT_TOO_LARGE',
      'Required discussion context exceeds the input limit',
    )
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) throw failure()
      let response: Response
      try {
        response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${p.env.deepseekApiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        })
      } catch {
        if (!controller.signal.aborted && attempt === 0) continue
        throw failure()
      }
      if (!response.ok) {
        if (
          attempt === 0 &&
          !controller.signal.aborted &&
          (response.status === 429 || response.status >= 500)
        )
          continue
        throw failure()
      }
      let payload: any
      try {
        payload = await response.json()
      } catch {
        throw failure()
      }
      if (controller.signal.aborted) throw failure()
      const choice = payload?.choices?.[0]
      if (
        choice?.finish_reason !== 'stop' ||
        typeof choice?.message?.content !== 'string' ||
        !choice.message.content.trim()
      )
        throw failure()
      let exchange: unknown
      try {
        exchange = JSON.parse(choice.message.content)
      } catch {
        throw failure()
      }
      const input = payload?.usage?.prompt_tokens
      const output = payload?.usage?.completion_tokens
      return {
        exchange,
        usage: {
          inputTokens: Number.isSafeInteger(input) && input >= 0 ? input : 0,
          outputTokens:
            Number.isSafeInteger(output) && output >= 0 ? output : 0,
          estimatedCostMicros: null,
        },
      }
    }
    throw failure()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
