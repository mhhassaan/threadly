import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleSettings } from '../server/data/api'
const handle = ({ request }: { request: Request }) =>
  handleSettings(request, getPlatform())
export const Route = createFileRoute('/api/settings')({
  server: { handlers: { GET: handle, PATCH: handle } },
})
