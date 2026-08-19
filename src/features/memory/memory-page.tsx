import { Brain } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function MemoryPage() {
  return (
    <FeatureScreen
      icon={Brain}
      title="Memory"
      description="What this workspace remembers."
      emptyTitle="No memories yet"
      emptyDescription="Facts, decisions, and preferences the workspace learns will appear here."
    />
  )
}
