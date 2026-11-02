import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handlePostReactions } from '../server/data/api'

const handle = ({
  request,
  params,
}: {
  request: Request
  params: { threadId: string }
}) => handlePostReactions(request, getPlatform(), params.threadId)
export const Route = createFileRoute('/api/threads/$threadId/reactions')({
  server: { handlers: { PATCH: handle } },
})
