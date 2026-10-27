import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleThread } from '../server/data/api'

const handle = ({
  request,
  params,
}: {
  request: Request
  params: { threadId: string }
}) => handleThread(request, getPlatform(), params.threadId)
export const Route = createFileRoute('/api/threads/$threadId')({
  server: { handlers: { GET: handle, PATCH: handle, DELETE: handle } },
})
