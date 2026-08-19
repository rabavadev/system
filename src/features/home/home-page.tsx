import { Home } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function HomePage() {
  return (
    <FeatureScreen
      icon={Home}
      title="Home"
      description="Your workspace overview."
      emptyTitle="Nothing here yet"
      emptyDescription="Recent activity and the most important next steps will show up here."
    />
  )
}
