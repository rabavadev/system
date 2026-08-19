import { createFileRoute } from '@tanstack/react-router'

import { AgentsPage } from '~/features/agents/agents-page'
import { getAgentsPageData } from '~/features/agents/server'

export const Route = createFileRoute('/agents')({
  loader: () => getAgentsPageData(),
  component: AgentsPage,
})
