import { BarChart3 } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function AnalyticsPage() {
  return (
    <FeatureScreen
      icon={BarChart3}
      title="Analytics"
      description="How your content and campaigns perform."
      emptyTitle="No data yet"
      emptyDescription="Performance data will appear here once accounts are connected."
    />
  )
}
