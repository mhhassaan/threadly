import type { createAccountBoundary } from './auth-state'

type Boundary = ReturnType<typeof createAccountBoundary>
type View = {
  applied: (id: string | null) => void
  expired: (expired: boolean) => void
  broadcast: (id: string) => void
}

// AccountProvider delegates both session effects and asynchronous logout here.
export function createAccountTransitions(boundary: Boundary, view: View) {
  let identity: string | null = null
  let sessionId: string | null = null
  let initialized = false
  let generation = 0
  let logoutOwner: string | null = null
  function finishCleanup() {
    if (logoutOwner) boundary.logout(logoutOwner)
    logoutOwner = null
  }
  return {
    deleted(owner: string) {
      boundary.logout(owner)
      if (owner !== identity) return false
      generation++
      logoutOwner = null
      view.applied(null)
      view.expired(false)
      view.broadcast(owner)
      // Keep identity/session receipt so a stale refresh of this same deleted
      // session cannot expose it again. A new account/session can still apply.
      return true
    },
    async remoteLogout(id: string, refetch: () => Promise<void>) {
      if (id !== boundary.owner() && id !== identity) {
        boundary.logout(id)
        return
      }
      const started = ++generation
      logoutOwner = id
      boundary.logout(id)
      view.applied(null)
      view.expired(false)
      try {
        await refetch()
      } catch {
        /* Remain hidden until a new session. */
      }
      if (started === generation) finishCleanup()
    },
    apply(id: string | null, nextSessionId: string | null) {
      // Refreshing the same session must not re-expose consumers during logout.
      if (initialized && identity === id && sessionId === nextSessionId) return
      generation++
      initialized = true
      finishCleanup()
      identity = id
      sessionId = nextSessionId
      view.expired(!id && !!boundary.owner())
      boundary.observe(id)
      view.applied(id)
    },
    async signOut(
      request: () => Promise<{ error?: unknown }>,
      refetch: () => Promise<void>,
    ) {
      const started = ++generation
      const owner = boundary.owner() ?? identity
      logoutOwner = owner
      boundary.logout(owner)
      view.applied(null)
      view.expired(false)
      if (owner) view.broadcast(owner)
      try {
        const result = await request()
        if (result.error) throw new Error('Sign out failed')
      } catch {
        if (started !== generation) return
        finishCleanup()
        // Only the still-current session can recover from its logout failure.
        boundary.observe(identity)
        view.applied(identity)
        throw new Error(
          'Could not sign out. Check your connection and try again.',
        )
      }
      if (started !== generation) return
      // Remove any refill between the first cleanup and consumer unmount.
      finishCleanup()
      await refetch()
    },
  }
}
