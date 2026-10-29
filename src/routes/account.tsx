import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AccountPanel } from '../features/account/AccountPanel'
import { AppearancePanel } from '../components/AppearancePanel'
import { Dialog } from '../components/Dialog'
import '../lib/appearance'

export const Route = createFileRoute('/account')({
  validateSearch: (search: Record<string, unknown>) => ({
    token:
      typeof search.token === 'string' && search.token.length <= 1024
        ? search.token
        : undefined,
    verified: search.verified === '1' ? '1' : undefined,
    error: typeof search.error === 'string' ? 'invalid-link' : undefined,
  }),
  head: () => ({
    meta: [
      { title: 'Your account — Threadly' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
  component: AccountPage,
})
function AccountPage() {
  const search = Route.useSearch()
  const [appearance, setAppearance] = useState(false)
  useEffect(() => {
    document.documentElement.classList.remove('reader-page')
  }, [])
  return (
    <>
      <header className="app-header">
        <a className="brand" href="/" aria-label="Threadly home">
          <img
            className="brand-symbol"
            src="/brand/threadly-mark.svg"
            width="36"
            height="36"
            alt=""
          />
          <span className="brand-wordmark">threadly</span>
          <small>BETA</small>
        </a>
        <nav aria-label="Main navigation">
          <a href="/">Create a thread</a>
          <a href="/account" className="nav-active" aria-current="page">
            Account
          </a>
        </nav>
        <div className="header-tools">
          <button
            className="appearance-button"
            aria-label="Appearance and themes"
            onClick={() => setAppearance(true)}
          >
            ◐ <span>Appearance</span>
          </button>
        </div>
      </header>
      <main className="dashboard account-page">
        <h1>Your account</h1>
        <section className="panel account-card" aria-label="Account access">
          <AccountPanel
            token={search.token}
            verified={search.verified === '1'}
            linkError={!!search.error}
          />
        </section>
        <a className="account-back" href="/">
          ← Back to your threads
        </a>
      </main>
      {appearance && (
        <Dialog
          title="Make yourself comfortable"
          onClose={() => setAppearance(false)}
        >
          <AppearancePanel onClose={() => setAppearance(false)} />
        </Dialog>
      )}
    </>
  )
}
