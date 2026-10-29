import { ApiError } from '../../lib/account-thread'

export type Persona = {
  id: string
  name: string
  handle: string
  kind: 'regular' | 'guest'
  voice: string
  version: number
}
const regulars: Persona[] = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Flint', handle: 'flint_ai', kind: 'regular', voice: 'Skeptic: concise, dry humor; challenges unsupported leaps without automatic opposition.', version: 1 },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Prism', handle: 'prism_ai', kind: 'regular', voice: 'Analyst: evidence-minded and precise; explains uncertainty and concedes supported corrections.', version: 1 },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Ripple', handle: 'ripple_ai', kind: 'regular', voice: 'Conversationalist: informal, relatable examples; playful when appropriate without invented personal experience.', version: 1 },
  { id: '10000000-0000-4000-8000-000000000004', name: 'Orbit', handle: 'orbit_ai', kind: 'regular', voice: 'Thoughtful challenger: patient disagreement and alternative interpretations; can agree or change position.', version: 1 },
]

// A namespaced thread identity gives each thread one stable fictional guest. It is
// an identity convention, never an authorization boundary or a source of entropy.
export function getCast(threadId: string): Persona[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId))
    throw new ApiError(400, 'INVALID_INPUT', 'Invalid thread identity')
  const id = `guest:${threadId.toLowerCase()}`
  return [...regulars.map(p => ({ ...p })), { id, name: 'Echo', handle: 'echo_guest_ai', kind: 'guest', voice: 'Thread guest: curious, focused on this discussion; no cross-thread personal memory or invented credentials.', version: 1 }]
}
