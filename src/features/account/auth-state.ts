import type { QueryClient } from '@tanstack/react-query'

export type FormMode = 'login' | 'signup' | 'forgot' | 'reset' | 'verify'
export type AuthFields = {
  name?: string
  email?: string
  password?: string
  confirm?: string
}
export type AccountUser = { id: string; name: string; verified: boolean }
const ownerKey = 'threadly-account-owner'
const draftPrefix = (userId: string) =>
  `threadly-account:${encodeURIComponent(userId)}:draft:`
export function draftKey(userId: string, name: string) {
  return draftPrefix(userId) + encodeURIComponent(name)
}
export function clearAccountCache(client: QueryClient, userId: string): void {
  const filter = { queryKey: ['account', userId] }
  void client.cancelQueries(filter)
  client.removeQueries(filter)
}
export function createAccountBoundary(client: QueryClient, storage?: Storage) {
  let owner: string | null = null
  try {
    owner = storage?.getItem(ownerKey) ?? null
  } catch {}
  function clearDrafts(id: string) {
    try {
      for (let i = (storage?.length ?? 0) - 1; i >= 0; i--) {
        const key = storage?.key(i)
        if (key?.startsWith(draftPrefix(id))) storage?.removeItem(key)
      }
    } catch {}
  }
  return {
    observe(id: string | null) {
      if (owner && owner !== id) clearAccountCache(client, owner)
      // A lost/expired session may be retried by the same owner. Never show its
      // private cache while signed out, but preserve that owner's session draft.
      if (!id) return
      if (owner && owner !== id) clearDrafts(owner)
      owner = id
      try {
        storage?.setItem(ownerKey, id)
      } catch {}
    },
    logout(id = owner) {
      if (id) {
        clearAccountCache(client, id)
        clearDrafts(id)
      }
      if (id === owner) {
        owner = null
        try {
          storage?.removeItem(ownerKey)
        } catch {}
      }
    },
    owner: () => owner,
  }
}
export function mapAccountUser(
  user: { id: string; name: string; emailVerified: boolean } | null | undefined,
): AccountUser | null {
  return user
    ? { id: user.id, name: user.name, verified: user.emailVerified }
    : null
}
export function validateAuthForm(
  mode: FormMode,
  fields: AuthFields,
): { field: keyof AuthFields; message: string } | null {
  if (mode === 'signup' && !fields.name?.trim())
    return { field: 'name', message: 'Add your name.' }
  if (
    mode !== 'reset' &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email?.trim() ?? '')
  )
    return { field: 'email', message: 'Enter a valid email address.' }
  if (
    ['login', 'signup', 'reset'].includes(mode) &&
    (!fields.password ||
      fields.password.length < 12 ||
      fields.password.length > 128)
  )
    return {
      field: 'password',
      message: 'Use a password between 12 and 128 characters.',
    }
  if (['signup', 'reset'].includes(mode) && fields.password !== fields.confirm)
    return { field: 'confirm', message: 'Your passwords do not match.' }
  return null
}
