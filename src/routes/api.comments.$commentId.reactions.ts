import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleCommentReactions } from '../server/data/api'

const handle = ({
  request,
  params,
}: {
  request: Request
  params: { commentId: string }
}) => handleCommentReactions(request, getPlatform(), params.commentId)
export const Route = createFileRoute('/api/comments/$commentId/reactions')({
  server: { handlers: { PATCH: handle } },
})
