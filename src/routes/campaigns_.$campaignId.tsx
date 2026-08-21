import { createFileRoute, notFound } from '@tanstack/react-router'

import { CampaignDetailPage } from '~/features/campaigns/campaign-detail-page'
import { getCampaignDetailData } from '~/features/campaigns/server'

export const Route = createFileRoute('/campaigns_/$campaignId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.campaignId)) {
      throw notFound()
    }
    const data = await getCampaignDetailData({ data: { id: params.campaignId } })
    if (!data?.campaign) {
      throw notFound()
    }
    return data
  },
  component: CampaignDetailRoute,
})

function CampaignDetailRoute() {
  const { campaign, brands, productsByBrand, allAccounts, activeWorkflows, metricDefinitions } =
    Route.useLoaderData()
  return (
    <CampaignDetailPage
      campaign={campaign}
      brands={brands}
      productsByBrand={productsByBrand}
      allAccounts={allAccounts}
      activeWorkflows={activeWorkflows}
      metricDefinitions={metricDefinitions}
    />
  )
}
