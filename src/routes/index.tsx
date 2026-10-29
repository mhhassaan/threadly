import { createFileRoute } from '@tanstack/react-router'
import { Threadly } from '../components/Threadly'
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    reader: typeof search.reader === 'string' ? search.reader : undefined,
    thread:
      typeof search.thread === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        search.thread,
      )
        ? search.thread
        : undefined,
    motion: ['forward', 'back', 'none'].includes(String(search.motion))
      ? String(search.motion)
      : undefined,
  }),
  component: Home,
})
function Home() {
  const search = Route.useSearch()
  return (
    <Threadly
      readerToken={search.thread ? undefined : search.reader}
      threadId={search.thread}
      motion={search.motion}
    />
  )
}
