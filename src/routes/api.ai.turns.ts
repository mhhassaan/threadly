import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleAiTurns } from '../server/data/api'
export const Route = createFileRoute('/api/ai/turns')({
  server: {
    handlers: {
      POST: ({ request }) => handleAiTurns(request, getPlatform(), getPlatform),
      GET: ({ request }) => handleAiTurns(request, getPlatform(), getPlatform),
      DELETE: ({ request }) =>
        handleAiTurns(request, getPlatform(), getPlatform),
    },
  },
})
