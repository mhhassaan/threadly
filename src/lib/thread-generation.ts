import type { ThreadRecord } from './thread'
export type GenerationInput = {
  requestId: string
  mode: 'text' | 'file' | 'url'
  source: string
  depth: 'quick' | 'balanced' | 'detailed'
  length: 'auto' | number
  noticeVersion: string
}
export type GenerationStatus = {
  id: string
  status: 'reserved' | 'running' | 'complete' | 'failed' | 'cancelled' | 'stale'
  phase: 'preparing' | 'writing' | null
  record?: ThreadRecord
  errorCode?: string
}
export type GenerationQuota = {
  kind: 'guest' | 'account'
  limit: 2 | 10
  used: number
  reserved: number
  remaining: number
  resetAt: string | null
}
