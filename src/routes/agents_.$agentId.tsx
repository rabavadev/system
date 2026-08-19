import { createFileRoute, notFound } from '@tanstack/react-router'

import { AgentDetailPage } from '~/features/agents/agent-detail-page'
import { getAgentDetailData } from '~/features/agents/server'

export const Route = createFileRoute('/agents_/$agentId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.agentId)) {
      throw notFound()
    }
    const data = await getAgentDetailData({ data: { id: params.agentId } })
    if (!data) {
      throw notFound()
    }
    return data
  },
  component: AgentDetailPage,
})
