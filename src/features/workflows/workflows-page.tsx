import { Workflow } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function WorkflowsPage() {
  return (
    <FeatureScreen
      icon={Workflow}
      title="Workflows"
      description="Repeatable processes your agents can run."
      emptyTitle="No workflows yet"
      emptyDescription="Define a workflow once, then let agents run it on demand or on a schedule."
    />
  )
}
