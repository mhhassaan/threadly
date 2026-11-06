import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleGenerationClaim } from '../server/thread-generation/api'
export const Route = createFileRoute('/api/generation/claim')({
  server: {
    handlers: {
      POST: ({ request }) => handleGenerationClaim(request, getPlatform()),
    },
  },
})
