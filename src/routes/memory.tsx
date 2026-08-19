import { createFileRoute } from '@tanstack/react-router'

import { MemoryPage } from '~/features/memory/memory-page'
import { getMemoryPageData } from '~/features/memory/server'

export const Route = createFileRoute('/memory')({
  loader: () => getMemoryPageData({ data: {} }),
  component: MemoryRoute,
})

function MemoryRoute() {
  const data = Route.useLoaderData()
  return <MemoryPage data={data} />
}
