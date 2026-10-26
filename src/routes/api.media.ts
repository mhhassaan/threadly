import { createFileRoute } from '@tanstack/react-router'
import api from '../server/article'
export const Route = createFileRoute('/api/media')({
  server: { handlers: { GET: ({ request }) => api.fetch(request) } },
})
