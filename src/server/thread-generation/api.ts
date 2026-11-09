import { ApiError } from '../../lib/account-thread'
import { processingNoticeVersion } from '../../lib/ai-processing'
import type { GenerationInput } from '../../lib/thread-generation'
import { assignMedia } from '../../lib/thread'
import type { Platform } from '../platform'
import { invalid, object, uuid } from '../data/validation'
import { resolveGenerationPrincipal, accountPrincipal } from './identity'
import {
  claimForPrincipal,
  getGenerationQuota,
  retireGenerationJobs,
} from './quota'
import { normalizeInput, type Principal } from './policy'
import {
  assertGenerationCurrent,
  readGenerationInput,
  readGenerationByRequest,
  beginGenerationAttempt,
  cancelGeneration,
  completeGeneration,
  failGeneration,
  readGeneration,
  refineGenerationReservation,
  reserveGeneration,
} from './jobs'
import { retrieveGenerationSource } from './source'
import { prepareGenerationThread, writeGenerationThread } from './provider'
import { withDeadline } from './transport'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const json = (value: unknown, status = 200, cookie?: string) =>
  Response.json(value, {
    status,
    headers: { ...privateHeaders, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  })
async function respond(work: () => Promise<Response>) {
  try {
    return await work()
  } catch (error) {
    const known = error instanceof ApiError
    return json(
      {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'Unable to complete request',
      },
      known ? error.status : 500,
    )
  }
}
function method(request: Request, allowed: string[]) {
  if (!allowed.includes(request.method))
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (new URL(request.url).search) invalid()
}
async function body(
  request: Request,
  p: Platform,
  signal = request.signal,
): Promise<unknown> {
  if (request.headers.get('origin') !== new URL(p.env.authUrl).origin)
    throw new ApiError(403, 'UNTRUSTED_ORIGIN', 'Request origin is not allowed')
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new ApiError(415, 'JSON_REQUIRED', 'Use an application/json request')
  const tooLarge = () =>
    new ApiError(413, 'BODY_TOO_LARGE', 'Request is too large')
  if (Number(request.headers.get('content-length')) > 1048576) throw tooLarge()
  const reader = request.body?.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '',
    size = 0
  const abort = () => {
    void reader?.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted)
      throw new DOMException('Operation aborted', 'AbortError')
    if (reader)
      while (true) {
        const part = await reader.read()
        if (signal.aborted)
          throw new DOMException('Operation aborted', 'AbortError')
        if (part.done) break
        size += part.value.byteLength
        if (size > 1048576) {
          await reader.cancel()
          throw tooLarge()
        }
        text += decoder.decode(part.value, { stream: true })
      }
    text += decoder.decode()
    if (!text && request.method === 'DELETE') return {}
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ApiError || signal.aborted) throw error
    invalid('Invalid JSON')
  } finally {
    signal.removeEventListener('abort', abort)
    reader?.releaseLock()
  }
}
export function handleGenerationIdentity(request: Request, p: Platform) {
  return respond(async () => {
    method(request, ['POST'])
    const value = object(await body(request, p), ['noticeVersion'])
    if (value.noticeVersion !== processingNoticeVersion)
      invalid('Acknowledge the current AI notice')
    const { principal, setCookie } = await resolveGenerationPrincipal(
      p,
      request,
      { createGuest: true },
    )
    return json(await getGenerationQuota(p, principal), 200, setCookie)
  })
}
export function handleGenerationQuota(request: Request, p: Platform) {
  return respond(async () => {
    method(request, ['GET'])
    const { principal } = await resolveGenerationPrincipal(p, request, {
      createGuest: false,
    })
    return json(await getGenerationQuota(p, principal))
  })
}
export function handleGenerationClaim(request: Request, p: Platform) {
  return respond(async () => {
    method(request, ['POST'])
    object(await body(request, p), [])
    const principal = await accountPrincipal(p, request)
    if (!principal)
      throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue')
    await claimForPrincipal(p, principal, request)
    return json(await getGenerationQuota(p, principal))
  })
}
export function handleGenerationJob(request: Request, p: Platform, id: string) {
  if (request.method === 'POST') return executeGeneration(request, p, id)
  return respond(async () => {
    method(request, ['GET', 'DELETE'])
    uuid(id)
    if (request.method === 'DELETE') object(await body(request, p), [])
    const { principal } = await resolveGenerationPrincipal(p, request, {
      createGuest: false,
    })
    return json(
      request.method === 'GET'
        ? await readGeneration(p, principal, id)
        : await cancelGeneration(p, principal, id),
    )
  })
}
async function executeGeneration(request: Request, p: Platform, id: string) {
  return respond(async () => {
    let execution:
      Promise<{ principal: Principal; id: string } | undefined> | undefined
    try {
      return await withDeadline(request.signal, 120000, async (signal) => {
        method(request, ['POST'])
        uuid(id)
        object(await body(request, p, signal), [])
        const { principal } = await resolveGenerationPrincipal(p, request, {
          createGuest: false,
        })
        if (signal.aborted)
          throw new DOMException('Operation aborted', 'AbortError')
        const existing = await readGeneration(p, principal, id)
        if (existing.status !== 'reserved')
          return json(existing, existing.status === 'running' ? 202 : 200)
        if (signal.aborted)
          throw new DOMException('Operation aborted', 'AbortError')
        execution = beginGenerationAttempt(p, principal, id).then((won) =>
          won ? { principal, id } : undefined,
        )
        if (!(await execution)) {
          const current = await readGeneration(p, principal, id)
          return json(
            current,
            current.status === 'reserved' || current.status === 'running'
              ? 202
              : 200,
          )
        }
        if (signal.aborted)
          throw new DOMException('Operation aborted', 'AbortError')
        const input = await readGenerationInput(p, principal, id)
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        let timer: ReturnType<typeof setTimeout> | undefined,
          stopped = false
        const guard = async () => {
          if (signal.aborted || controller.signal.aborted)
            throw new DOMException('Operation aborted', 'AbortError')
          await assertGenerationCurrent(p, principal, id)
          if (signal.aborted || controller.signal.aborted)
            throw new DOMException('Operation aborted', 'AbortError')
        }
        const poll = async () => {
          try {
            await guard()
          } catch {
            controller.abort()
          }
          if (!stopped && !controller.signal.aborted)
            timer = setTimeout(poll, 500)
        }
        timer = setTimeout(poll, 500)
        try {
          await guard()
          const source = await retrieveGenerationSource(
            p,
            input,
            controller.signal,
            guard,
          )
          const prepared = prepareGenerationThread(input, source)
          await guard()
          await refineGenerationReservation(
            p,
            principal,
            id,
            prepared.requestBytes,
          )
          const written = await writeGenerationThread(
            p,
            prepared,
            controller.signal,
            guard,
          )
          await guard()
          const job = await completeGeneration(p, principal, id, {
            id: '',
            title: written.title,
            posts: written.posts,
            sourceText: source.text,
            sourceUrl: source.sourceUrl,
            source: source.source,
            media: assignMedia(source.media, written.posts, source.text),
            interactions: {},
            date: new Date().toISOString(),
          })
          return json(job)
        } finally {
          stopped = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
      })
    } catch (error) {
      // Resolve an in-flight atomic begin before cleanup: only its winner owns this execution.
      const active = await execution?.catch(() => undefined)
      if (active) {
        // Housekeeping scrubs revoked/claimed jobs even when the captured identity can no longer read them.
        await retireGenerationJobs(p, active.principal)
        if (request.signal.aborted)
          return json(await cancelGeneration(p, active.principal, active.id))
        if ((error as Error)?.name === 'AbortError')
          return json(
            await failGeneration(
              p,
              active.principal,
              active.id,
              'GENERATION_TIMEOUT',
            ),
          )
        return json(
          await failGeneration(
            p,
            active.principal,
            active.id,
            error instanceof ApiError ? error.code : 'GENERATION_FAILED',
          ),
        )
      }
      if ((error as Error)?.name === 'AbortError')
        throw new ApiError(
          request.signal.aborted ? 499 : 408,
          request.signal.aborted ? 'CANCELLED' : 'GENERATION_TIMEOUT',
          'Generation was interrupted',
        )
      throw error
    }
  })
}

/** Admission is short and side-effect free with respect to all providers. */
export function handleGeneration(request: Request, p: Platform) {
  return respond(async () => {
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams
      if (
        [...params.keys()].some((name) => name !== 'requestId') ||
        params.getAll('requestId').length !== 1
      )
        invalid()
      const requestId = uuid(params.get('requestId'))
      const { principal } = await resolveGenerationPrincipal(p, request, {
        createGuest: false,
      })
      return json(await readGenerationByRequest(p, principal, requestId))
    }
    method(request, ['POST'])
    const value = object(await body(request, p), [
      'requestId',
      'mode',
      'source',
      'depth',
      'length',
      'noticeVersion',
    ])
    const input = normalizeInput(value as unknown as GenerationInput)
    const { principal } = await resolveGenerationPrincipal(p, request, {
      createGuest: false,
    })
    const { job } = await reserveGeneration(p, principal, input)
    return json(
      job,
      job.status === 'reserved' || job.status === 'running' ? 202 : 200,
    )
  })
}
