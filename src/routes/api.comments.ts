import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleComments } from '../server/data/api'

const handle = ({ request }: { request: Request }) =>
  handleComments(request, getPlatform())
export const Route = createFileRoute('/api/comments')({
  server: { handlers: { POST: handle } },
})
