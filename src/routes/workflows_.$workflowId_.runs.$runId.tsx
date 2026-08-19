import { createFileRoute, notFound } from '@tanstack/react-router'

import { RunDetailPage } from '~/features/workflows/run-detail-page'
import { getRunDetailData } from '~/features/workflows/server'

export const Route = createFileRoute('/workflows_/$workflowId_/runs/$runId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.runId)) {
      throw notFound()
    }
    const data = await getRunDetailData({ data: { runId: params.runId } })
    if (!data || data.workflow.id !== params.workflowId) {
      throw notFound()
    }
    return data
  },
  component: RunDetailPage,
})
