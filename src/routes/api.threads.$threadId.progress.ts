import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleReadingProgress } from '../server/data/api'

const handle = ({
  request,
  params,
}: {
  request: Request
  params: { threadId: string }
}) => handleReadingProgress(request, getPlatform(), params.threadId)
export const Route = createFileRoute('/api/threads/$threadId/progress')({
  server: { handlers: { POST: handle } },
})
