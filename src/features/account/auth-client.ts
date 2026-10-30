import { createAuthClient } from 'better-auth/react'
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createAccountBoundary, resolveSessionUser } from './auth-state'
import { createAccountTransitions } from './account-transitions'
import type { AccountUser } from './auth-state'
export { clearAccountCache, draftKey } from './auth-state'

// Relative same-origin requests only. No server configuration or credentials.
// Verification callbacks must not navigate away from an unsaved editor at sign-in.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  disableDefaultFetchPlugins: true,
})
type Account = {
  user: AccountUser | null
  pending: boolean
  signOut: () => Promise<void>
  deleted: (owner: string) => void
}
type AccountStatus = Account & {
  unavailable: boolean
  expired: boolean
  retry: () => Promise<void>
}
const AccountContext = createContext<AccountStatus | null>(null)
const logoutKey = 'threadly-account-logout'
export function AccountProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const session = authClient.useSession()
  const boundary = useRef<ReturnType<typeof createAccountBoundary> | null>(null)
  const transitions = useRef<ReturnType<
    typeof createAccountTransitions
  > | null>(null)
  const [appliedOwner, setAppliedOwner] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const confirmed = useRef<AccountUser | null>(null)
  const [rejectedSession, setRejectedSession] = useState<string | null>(null)
  const sessionId = session.data?.session.id ?? null
  const user =
    rejectedSession && rejectedSession === sessionId
      ? null
      : resolveSessionUser(session.data?.user, session.error, confirmed.current)
  const id = user?.id ?? null
  useEffect(() => {
    let storage: Storage | undefined
    try {
      storage = sessionStorage
    } catch {}
    boundary.current ??= createAccountBoundary(client, storage)
    transitions.current ??= createAccountTransitions(boundary.current, {
      applied: setAppliedOwner,
      expired: setExpired,
      broadcast: (userId) => {
        try {
          localStorage.setItem(
            logoutKey,
            JSON.stringify({ userId, nonce: crypto.randomUUID() }),
          )
        } catch {}
      },
    })
    const onLogout = (event: StorageEvent) => {
      if (event.key !== logoutKey || !event.newValue) return
      try {
        const message = JSON.parse(event.newValue)
        if (typeof message.userId === 'string') {
          void transitions.current?.remoteLogout(message.userId, () =>
            session.refetch(),
          )
        }
      } catch {}
    }
    window.addEventListener('storage', onLogout)
    const onExpired = (event: Event) => {
      if ((event as CustomEvent<{ owner?: string }>).detail?.owner !== id)
        return
      confirmed.current = null
      setRejectedSession(sessionId)
      transitions.current?.apply(null, null)
      void session.refetch()
    }
    window.addEventListener('threadly:session-expired', onExpired)
    return () => {
      window.removeEventListener('storage', onLogout)
      window.removeEventListener('threadly:session-expired', onExpired)
    }
  }, [client, sessionId, id])
  useEffect(() => {
    if (session.isPending) return
    if (!session.error) confirmed.current = user
    transitions.current?.apply(id, session.data?.session.id ?? null)
  }, [id, session.isPending, session.error, session.data])
  const value: AccountStatus = {
    user: id === appliedOwner ? user : null,
    pending: session.isPending || (!!id && id !== appliedOwner),
    unavailable: !!session.error,
    expired,
    retry: () => session.refetch(),
    deleted: (owner) => {
      if (transitions.current?.deleted(owner)) {
        confirmed.current = null
        setRejectedSession(sessionId)
        const atom = authClient.$store.atoms.session
        const current = atom.get()
        if (current.data?.user.id === owner)
          atom.set({
            ...current,
            data: null,
            error: null,
            isPending: false,
            isRefetching: false,
          })
        // Refetch cancels the pinned client's older session flight. Local identity
        // and drafts are already gone even when this network request fails.
        void session.refetch().catch(() => {})
      }
    },
    signOut: async () => {
      await transitions.current?.signOut(
        () => authClient.signOut(),
        () => session.refetch(),
      )
    },
  }
  return createElement(AccountContext.Provider, { value }, children)
}
export function useAccount(): Account {
  return useAccountStatus()
}
export function useAccountStatus(): AccountStatus {
  const account = useContext(AccountContext)
  if (!account) throw new Error('AccountProvider is required')
  return account
}
