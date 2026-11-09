import { accountRequest } from '../account/library'
import type {
  GenerationInput,
  GenerationQuota,
  GenerationStatus,
} from '../../lib/thread-generation'
export const getGenerationQuota = (owner: string, signal?: AbortSignal) =>
  accountRequest<GenerationQuota>(
    '/api/generation/quota',
    'GET',
    undefined,
    signal,
    owner,
  )
export const ensureGenerationIdentity = (
  owner: string,
  noticeVersion: string,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationQuota>(
    '/api/generation/identity',
    'POST',
    { noticeVersion },
    signal,
    owner,
  )
export const claimGuestUsage = (owner: string, signal?: AbortSignal) =>
  accountRequest<GenerationQuota>(
    '/api/generation/claim',
    'POST',
    {},
    signal,
    owner,
  )
export const startGeneration = (
  owner: string,
  input: GenerationInput,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationStatus>(
    '/api/generation',
    'POST',
    input,
    signal,
    owner,
  )
export const executeGeneration = (
  owner: string,
  id: string,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationStatus>(
    '/api/generation/' + encodeURIComponent(id),
    'POST',
    {},
    signal,
    owner,
  )
export const readGeneration = (
  owner: string,
  id: string,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationStatus>(
    '/api/generation/' + encodeURIComponent(id),
    'GET',
    undefined,
    signal,
    owner,
  )
export const readGenerationByRequest = (
  owner: string,
  requestId: string,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationStatus>(
    '/api/generation?requestId=' + encodeURIComponent(requestId),
    'GET',
    undefined,
    signal,
    owner,
  )
export const cancelGeneration = (
  owner: string,
  id: string,
  signal?: AbortSignal,
) =>
  accountRequest<GenerationStatus>(
    '/api/generation/' + encodeURIComponent(id),
    'DELETE',
    undefined,
    signal,
    owner,
  )
