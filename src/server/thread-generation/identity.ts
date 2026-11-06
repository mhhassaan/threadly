import type { Platform } from '../platform'
import { ApiError } from '../../lib/account-thread'
import { createAuth } from '../auth/auth'
import { assertPrincipal, digest, type Principal } from './policy'
import { claimForPrincipal } from './quota'
export type { Principal } from './policy'
export const guestCookieName = 'threadly_generation_guest'
export async function cookieGuest(
  p: Platform,
  request: Request,
): Promise<string | null> {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(guestCookieName + '='))
    ?.slice(guestCookieName.length + 1)
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const row = await p.db
    .prepare('SELECT id FROM generation_guests WHERE token_digest=?')
    .bind(await digest(token))
    .first<{ id: string }>()
  return row?.id ?? null
}
export async function accountPrincipal(
  p: Platform,
  request: Request,
): Promise<Extract<Principal, { kind: 'account' }> | null> {
  const result = await createAuth(p).api.getSession({
    headers: request.headers,
  })
  if (result) {
    const session = await p.db
      .prepare(
        'SELECT credential_generation FROM session WHERE id=? AND user_id=?',
      )
      .bind(result.session.id, result.user.id)
      .first<{ credential_generation: number }>()
    if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue')
    const principal: Principal = {
      kind: 'account',
      user: {
        userId: result.user.id,
        email: result.user.email,
        name: result.user.name,
        verified: result.user.emailVerified,
      },
      sessionId: result.session.id,
      credentialGeneration: session.credential_generation,
    }
    await assertPrincipal(p, principal)
    return principal
  }
  return null
}
export async function resolveGenerationPrincipal(
  p: Platform,
  request: Request,
  { createGuest }: { createGuest: boolean },
): Promise<{ principal: Principal; setCookie?: string }> {
  const principal = await accountPrincipal(p, request)
  if (principal) {
    await claimForPrincipal(p, principal, request)
    return { principal }
  }
  // An invalid signed-in cookie must never silently acquire a fresh anonymous trial.
  if (
    request.headers
      .get('cookie')
      ?.split(';')
      .some((x) => /^\s*(?:__Secure-)?better-auth\.session_token=/.test(x))
  )
    throw new ApiError(401, 'UNAUTHORIZED', 'Sign in again to continue')
  const guestId = await cookieGuest(p, request)
  if (guestId) return { principal: { kind: 'guest', guestId } }
  if (!createGuest)
    throw new ApiError(
      401,
      'GUEST_IDENTITY_REQUIRED',
      'Start a generation to continue',
    )
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
  const id = crypto.randomUUID()
  await p.db
    .prepare(
      'INSERT INTO generation_guests(id,token_digest,created_at) VALUES(?,?,?)',
    )
    .bind(id, await digest(token), new Date().toISOString())
    .run()
  return {
    principal: { kind: 'guest', guestId: id },
    setCookie: `${guestCookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
  }
}
