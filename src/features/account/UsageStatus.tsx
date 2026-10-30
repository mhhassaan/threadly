import { useQuery } from '@tanstack/react-query'
import type { AiUsageStatus } from '../../lib/account-thread'
import { accountRequest } from './library'

export function UsageStatus({ owner }: { owner: string }) {
  const usage = useQuery({
    queryKey: ['account', owner, 'usage'],
    retry: false,
    queryFn: ({ signal }) =>
      accountRequest<AiUsageStatus>(
        '/api/usage',
        'GET',
        undefined,
        signal,
        owner,
      ),
  })
  const status = usage.data
  return (
    <section aria-label="AI allowance">
      <h4>Daily AI allowance</h4>
      {status ? (
        <>
          <p>
            {status.opening.remaining} of {status.opening.limit} openings and{' '}
            {status.reply.remaining} of {status.reply.limit} follow-up turns
            remaining today (UTC).
          </p>
          <p>
            {status.availability === 'available'
              ? 'AI is available. Each request still checks your allowance.'
              : status.availability === 'paused'
                ? 'AI is paused. Enable it in discussion settings when ready.'
                : status.availability === 'busy'
                  ? 'Your active AI requests are at capacity.'
                  : 'AI is temporarily unavailable. Reading and manual comments remain available.'}
          </p>
        </>
      ) : (
        <p role="status">
          {usage.isError
            ? 'Could not load your AI allowance.'
            : 'Checking AI allowance...'}
        </p>
      )}
      <button
        className="text-button"
        disabled={usage.isFetching}
        onClick={() => void usage.refetch()}
      >
        Refresh allowance
      </button>
    </section>
  )
}
