import { createFileRoute } from '@tanstack/react-router'
import { Threadly } from '../components/Threadly'
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    reader: typeof search.reader === 'string' ? search.reader : undefined,
    motion: ['forward', 'back', 'none'].includes(String(search.motion))
      ? String(search.motion)
      : undefined,
  }),
  component: Home,
})
function Home() {
  const search = Route.useSearch()
  return <Threadly readerToken={search.reader} motion={search.motion} />
}
