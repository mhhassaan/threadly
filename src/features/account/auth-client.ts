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
import { createAccountBoundary, mapAccountUser } from './auth-state'
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
  const user = session.error ? null : mapAccountUser(session.data?.user)
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
          boundary.current?.logout(message.userId)
          void session.refetch()
        }
      } catch {}
    }
    window.addEventListener('storage', onLogout)
    return () => window.removeEventListener('storage', onLogout)
  }, [client])
  useEffect(() => {
    if (session.isPending) return
    transitions.current?.apply(id, session.data?.session.id ?? null)
  }, [id, session.isPending, session.error, session.data])
  const value: AccountStatus = {
    user: id === appliedOwner ? user : null,
    pending: session.isPending || (!!id && id !== appliedOwner),
    unavailable: !!session.error,
    expired,
    retry: () => session.refetch(),
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
