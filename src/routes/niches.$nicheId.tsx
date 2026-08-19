import { createFileRoute, notFound } from '@tanstack/react-router'

import { NicheDetailPage } from '~/features/niches/niche-detail-page'
import { getNicheDetail } from '~/features/niches/server'

export const Route = createFileRoute('/niches/$nicheId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.nicheId)) {
      throw notFound()
    }
    const data = await getNicheDetail({ data: { id: params.nicheId } })
    if (!data) {
      throw notFound()
    }
    return data
  },
  component: NicheDetailRoute,
})

function NicheDetailRoute() {
  const data = Route.useLoaderData()
  return <NicheDetailPage data={data} />
}
