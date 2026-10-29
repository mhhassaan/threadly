import { createFileRoute } from '@tanstack/react-router'
import { getPlatform } from '../server/platform'
import { handleAccount } from '../server/data/api'
export const Route = createFileRoute('/api/account')({
  server: {
    handlers: {
      DELETE: ({ request }) => handleAccount(request, getPlatform()),
    },
  },
})
