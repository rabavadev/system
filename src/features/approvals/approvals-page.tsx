import { CircleCheck } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function ApprovalsPage() {
  return (
    <FeatureScreen
      icon={CircleCheck}
      title="Approvals"
      description="Work waiting for your review."
      emptyTitle="Nothing to review"
      emptyDescription="When agents finish work that needs your sign-off, it will show up here."
    />
  )
}
