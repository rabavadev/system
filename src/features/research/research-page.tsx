import { FlaskConical } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function ResearchPage() {
  return (
    <FeatureScreen
      icon={FlaskConical}
      title="Research"
      description="Findings gathered for your brands and niches."
      emptyTitle="No research yet"
      emptyDescription="Research briefs and findings will be collected here."
    />
  )
}
