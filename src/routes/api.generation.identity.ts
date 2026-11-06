import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleGenerationIdentity } from '../server/thread-generation/api'
export const Route = createFileRoute('/api/generation/identity')({
  server: {
    handlers: {
      POST: ({ request }) => handleGenerationIdentity(request, getPlatform()),
    },
  },
})
