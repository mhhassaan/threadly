import { getSettings, updateSettings } from './settings'
import { ApiError } from '../../lib/account-thread'
import { requireUser } from '../auth/session'
import type { Platform } from '../platform'
import { appendHumanComment } from './comments'
import { importLocalThread } from './import'
import {
  deleteThread,
  getSnapshot,
  listThreads,
  patchOwnedThread,
  saveThread,
} from './threads'
import {
  humanComment,
  invalid,
  legacyThreadRecord,
  object,
  patchThread,
  threadRecord,
} from './validation'

const privateHeaders = { 'Cache-Control': 'private, no-store' }
const maxBodyBytes = 1_048_576
async function body(request: Request, platform: Platform): Promise<unknown> {
  if (request.headers.get('origin') !== new URL(platform.env.authUrl).origin)
    throw new ApiError(403, 'UNTRUSTED_ORIGIN', 'Request origin is not allowed')
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new ApiError(415, 'JSON_REQUIRED', 'Use an application/json request')
  const tooLarge = () =>
    new ApiError(413, 'BODY_TOO_LARGE', 'Request is too large')
  if (Number(request.headers.get('content-length')) > maxBodyBytes)
    throw tooLarge()
  const reader = request.body?.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let length = 0
  let text = ''
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > maxBodyBytes) {
          await reader.cancel()
          throw tooLarge()
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      if (error instanceof ApiError) throw error
      invalid('Invalid JSON')
    } finally {
      reader.releaseLock()
    }
  }
  if (!text && request.method === 'DELETE') return {}
  try {
    return JSON.parse(text)
  } catch {
    invalid('Invalid JSON')
  }
}
async function respond(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work()
  } catch (error) {
    const known = error instanceof ApiError
    return Response.json(
      {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'Unable to complete request',
      },
      { status: known ? error.status : 500, headers: privateHeaders },
    )
  }
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders })
}
function unsupported(): never {
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
}
export function handleLibrary(
  request: Request,
  platform: Platform,
): Promise<Response> {
  return respond(async () => {
    const user = await requireUser(request, platform)
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams
      if (
        [...params.keys()].some((key) => key !== 'cursor') ||
        params.getAll('cursor').length > 1
      )
        invalid()
      return json(await listThreads(platform, user, params.get('cursor')))
    }
    if (request.method !== 'POST') unsupported()
    const input = object(await body(request, platform), [
      'record',
      'migrationId',
    ])
    if (input.migrationId !== undefined)
      return json(
        await importLocalThread(platform, user, {
          migrationId: input.migrationId as string,
          record: legacyThreadRecord(input.record),
        }),
        201,
      )
    return json(
      await saveThread(platform, user, threadRecord(input.record), null),
      201,
    )
  })
}
export function handleThread(
  request: Request,
  platform: Platform,
  threadId: string,
): Promise<Response> {
  return respond(async () => {
    const user = await requireUser(request, platform)
    if (request.method === 'GET')
      return json(await getSnapshot(platform, user, threadId))
    if (request.method === 'PATCH')
      return json(
        await patchOwnedThread(
          platform,
          user,
          threadId,
          patchThread(await body(request, platform)),
        ),
      )
    if (request.method === 'DELETE') {
      object(await body(request, platform), [])
      await deleteThread(platform, user, threadId)
      return new Response(null, { status: 204, headers: privateHeaders })
    }
    unsupported()
  })
}
export function handleComments(
  request: Request,
  platform: Platform,
): Promise<Response> {
  return respond(async () => {
    const user = await requireUser(request, platform)
    if (request.method !== 'POST') unsupported()
    return json(
      await appendHumanComment(
        platform,
        user,
        humanComment(await body(request, platform)),
      ),
      201,
    )
  })
}

export function handleSettings(
  request: Request,
  platform: Platform,
): Promise<Response> {
  return respond(async () => {
    const user = await requireUser(request, platform)
    if (request.method === 'GET') return json(await getSettings(platform, user))
    if (request.method !== 'PATCH') unsupported()
    const patch = object(await body(request, platform), [
      'aiEnabled',
      'memoryEnabled',
      'acknowledgeConsent',
    ])
    for (const value of Object.values(patch))
      if (typeof value !== 'boolean') invalid()
    return json(
      await updateSettings(
        platform,
        user,
        patch as {
          aiEnabled?: boolean
          memoryEnabled?: boolean
          acknowledgeConsent?: boolean
        },
      ),
    )
  })
}
