import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleGeneration } from '../server/thread-generation/api'
export const Route = createFileRoute('/api/generation')({
  server: {
    handlers: {
      GET: ({ request }) => handleGeneration(request, getPlatform()),
      POST: ({ request }) => handleGeneration(request, getPlatform()),
    },
  },
})
