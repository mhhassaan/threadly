import { createFileRoute } from '@tanstack/react-router'
import api from '../server/article'
export const Route = createFileRoute('/api/article')({
  server: { handlers: { POST: ({ request }) => api.fetch(request) } },
})
