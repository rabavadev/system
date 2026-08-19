import { createFileRoute } from '@tanstack/react-router'

import { NotFound } from '~/components/ui/not-found'
import { ContextInspectorPage } from '~/features/dev/context-inspector-page'
import { getDevContextOptions } from '~/features/dev/server'

/**
 * Development-only Context Inspector. Deliberately NOT in the navigation;
 * outside dev builds the loader returns null and the route renders
 * NotFound, and the server functions refuse to run.
 */
export const Route = createFileRoute('/dev-context')({
  loader: () => (import.meta.env.DEV ? getDevContextOptions() : null),
  component: DevContextRoute,
})

function DevContextRoute() {
  const options = Route.useLoaderData()
  if (!import.meta.env.DEV || !options) {
    return <NotFound />
  }
  return <ContextInspectorPage options={options} />
}
