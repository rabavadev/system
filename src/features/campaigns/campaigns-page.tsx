import { Megaphone } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function CampaignsPage() {
  return (
    <FeatureScreen
      icon={Megaphone}
      title="Campaigns"
      description="Planned and running campaigns."
      emptyTitle="No campaigns yet"
      emptyDescription="Create a campaign to coordinate content and publishing toward a goal."
    />
  )
}
