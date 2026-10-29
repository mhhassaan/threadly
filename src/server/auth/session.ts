import type { Platform } from '../platform'
import { ApiError, type UserContext } from '../../lib/account-thread'
import { createAuth } from './auth'

export async function requireUser(
  request: Request,
  platform: Platform,
  verified = true,
): Promise<UserContext> {
  const result = await createAuth(platform).api.getSession({
    headers: request.headers,
  })
  if (!result || result.session.expiresAt.getTime() <= Date.now())
    throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue')
  if (verified && !result.user.emailVerified)
    throw new ApiError(
      403,
      'EMAIL_VERIFICATION_REQUIRED',
      'Verify your email to continue',
    )
  const { id, email, name, emailVerified } = result.user
  return { userId: id, email, name, verified: emailVerified }
}
