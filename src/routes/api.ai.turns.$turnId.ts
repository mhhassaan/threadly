import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleAiTurn } from '../server/data/api'
const handle = ({
  request,
  params,
}: {
  request: Request
  params: { turnId: string }
}) => handleAiTurn(request, getPlatform(), params.turnId)
export const Route = createFileRoute('/api/ai/turns/$turnId')({
  server: { handlers: { GET: handle, DELETE: handle } },
})
