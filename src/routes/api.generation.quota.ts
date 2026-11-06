import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleGenerationQuota } from '../server/thread-generation/api'
export const Route = createFileRoute('/api/generation/quota')({
  server: {
    handlers: {
      GET: ({ request }) => handleGenerationQuota(request, getPlatform()),
    },
  },
})
