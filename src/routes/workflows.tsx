import { createFileRoute } from '@tanstack/react-router'

import { getWorkflowsData } from '~/features/workflows/server'
import { WorkflowsPage } from '~/features/workflows/workflows-page'

export const Route = createFileRoute('/workflows')({
  loader: () => getWorkflowsData(),
  component: WorkflowsPage,
})
