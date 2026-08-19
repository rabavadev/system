import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'

import { AppShell } from '~/components/layout/app-shell'
import { ErrorState } from '~/components/ui/error-state'
import { Loading } from '~/components/ui/loading'
import { NotFound } from '~/components/ui/not-found'
import { getWorkspaceSummary } from '~/features/workspace/server'
import appCss from '~/styles.css?url'

export const Route = createRootRoute({
  loader: () => getWorkspaceSummary(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Growth Workspace' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
  errorComponent: ({ error, reset }) => (
    <div className="p-6">
      <ErrorState error={error} reset={reset} />
    </div>
  ),
  notFoundComponent: () => <NotFound />,
  pendingComponent: () => (
    <div className="flex justify-center p-6">
      <Loading />
    </div>
  ),
})

function RootComponent() {
  const workspace = Route.useLoaderData()
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell workspaceName={workspace?.name ?? null}>
          <Outlet />
        </AppShell>
        <Scripts />
      </body>
    </html>
  )
}
