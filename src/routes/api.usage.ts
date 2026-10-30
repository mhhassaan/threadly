import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleUsage } from '../server/data/api'
export const Route = createFileRoute('/api/usage')({
  server: {
    handlers: { GET: ({ request }) => handleUsage(request, getPlatform()) },
  },
})
