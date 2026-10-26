import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import styles from '../style.css?url'
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: 'utf-8' },
        {
          name: 'viewport',
          content:
            'width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content',
        },
        { name: 'theme-color', content: '#f8f9f5' },
        { title: 'Threadly — Read the big picture' },
        {
          name: 'description',
          content:
            'Turn articles into clear, detailed threads in your own reading window.',
        },
      ],
      links: [
        { rel: 'stylesheet', href: styles },
        {
          rel: 'icon',
          href: '/brand/threadly-mark.svg',
          type: 'image/svg+xml',
        },
        {
          rel: 'preload',
          href: '/fonts/jersey25-regular.ttf',
          as: 'font',
          type: 'font/ttf',
          crossOrigin: 'anonymous',
        },
      ],
    }),
    component: Root,
    shellComponent: Document,
    notFoundComponent: () => (
      <main className="dashboard">
        <h1>Page not found</h1>
        <a href="/">Create a thread</a>
      </main>
    ),
  },
)
function Root() {
  const { queryClient } = Route.useRouteContext()
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  )
}
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.classList.toggle('reader-page',new URLSearchParams(location.search).has('reader'));",
          }}
        />
        <script src="/appearance.js" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
