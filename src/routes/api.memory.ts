import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleMemory } from '../server/data/api'
export const Route = createFileRoute('/api/memory')({
  server: {
    handlers: {
      GET: ({ request }) => handleMemory(request, getPlatform()),
      DELETE: ({ request }) => handleMemory(request, getPlatform()),
    },
  },
})
