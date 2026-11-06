import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleGenerationJob } from '../server/thread-generation/api'
export const Route = createFileRoute('/api/generation/$generationId')({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        handleGenerationJob(request, getPlatform(), params.generationId),
      GET: ({ request, params }) =>
        handleGenerationJob(request, getPlatform(), params.generationId),
      DELETE: ({ request, params }) =>
        handleGenerationJob(request, getPlatform(), params.generationId),
    },
  },
})
