import type { AccountSettings, UserContext } from '../../lib/account-thread'
import type { Platform } from '../platform'
import { requireVerified } from './threads'

export async function getSettings(
  p: Platform,
  u: UserContext,
): Promise<AccountSettings> {
  requireVerified(u)
  const row = await p.db
    .prepare('SELECT * FROM account_settings WHERE owner_id = ?')
    .bind(u.userId)
    .first<{
      ai_enabled: number
      memory_enabled: number
      consent_at: string | null
      memory_epoch: number
    }>()
  return {
    aiEnabled: !!row?.ai_enabled,
    memoryEnabled: !!row?.memory_enabled,
    consentAt: row?.consent_at ?? null,
    memoryEpoch: row?.memory_epoch ?? 0,
  }
}
export async function updateSettings(
  p: Platform,
  u: UserContext,
  patch: {
    aiEnabled?: boolean
    memoryEnabled?: boolean
    acknowledgeConsent?: boolean
  },
): Promise<AccountSettings> {
  requireVerified(u)
  const now = new Date().toISOString()
  await p.db.batch([
    p.db
      .prepare(
        'INSERT INTO account_settings (owner_id) VALUES (?) ON CONFLICT(owner_id) DO NOTHING',
      )
      .bind(u.userId),
    p.db
      .prepare(
        `UPDATE account_settings SET ai_enabled = COALESCE(?, ai_enabled), memory_enabled = COALESCE(?, memory_enabled), consent_at = CASE WHEN ? THEN COALESCE(consent_at, ?) ELSE consent_at END, settings_epoch = settings_epoch + 1 WHERE owner_id = ? AND (ai_enabled IS NOT COALESCE(?, ai_enabled) OR memory_enabled IS NOT COALESCE(?, memory_enabled) OR (? = 1 AND consent_at IS NULL))`,
      )
      .bind(
        patch.aiEnabled === undefined ? null : Number(patch.aiEnabled),
        patch.memoryEnabled === undefined ? null : Number(patch.memoryEnabled),
        Number(patch.acknowledgeConsent === true),
        now,
        u.userId,
        patch.aiEnabled === undefined ? null : Number(patch.aiEnabled),
        patch.memoryEnabled === undefined ? null : Number(patch.memoryEnabled),
        Number(patch.acknowledgeConsent === true),
      ),
    p.db
      .prepare(
        "UPDATE ai_turns SET status = 'cancelled', error_code = CASE WHEN (SELECT ai_enabled FROM account_settings WHERE owner_id = ?) = 0 THEN 'AI_DISABLED' ELSE 'SETTINGS_CHANGED' END WHERE owner_id = ? AND status IN ('reserved','running') AND settings_epoch <> (SELECT settings_epoch FROM account_settings WHERE owner_id = ?)",
      )
      .bind(u.userId, u.userId, u.userId),
  ])
  return getSettings(p, u)
}
