import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleLibrary } from '../server/data/api'

const handle = ({ request }: { request: Request }) =>
  handleLibrary(request, getPlatform())
export const Route = createFileRoute('/api/library')({
  server: { handlers: { GET: handle, POST: handle } },
})
