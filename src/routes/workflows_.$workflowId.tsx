import { createFileRoute, notFound } from '@tanstack/react-router'

import { getWorkflowDetailData } from '~/features/workflows/server'
import { WorkflowDetailPage } from '~/features/workflows/workflow-detail-page'

export const Route = createFileRoute('/workflows_/$workflowId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.workflowId)) {
      throw notFound()
    }
    const data = await getWorkflowDetailData({ data: { id: params.workflowId } })
    if (!data) {
      throw notFound()
    }
    return data
  },
  component: WorkflowDetailPage,
})
