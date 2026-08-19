import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { Bot, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'

import { CustomAgentForm } from './custom-agent-form'
import { EXECUTION_TYPE_LABEL, STATUS_LABEL } from './labels'
import type { AgentListItem } from './server'

const routeApi = getRouteApi('/agents')

export function AgentsPage() {
  const router = useRouter()
  const { agents } = routeApi.useLoaderData()
  const [showForm, setShowForm] = useState(false)

  const builtin = agents.filter((agent) => agent.origin === 'builtin')
  const custom = agents.filter((agent) => agent.origin === 'custom' && agent.status !== 'archived')
  const archived = agents.filter(
    (agent) => agent.origin === 'custom' && agent.status === 'archived',
  )

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Agents"
        description="The AI workers of this workspace. Pick who you talk to in Chat; each agent keeps its own versioned instructions."
        actions={
          <Button onClick={() => setShowForm(true)}>
            <Plus className="size-4" strokeWidth={1.75} />
            New agent
          </Button>
        }
      />

      <AgentTable title="Built-in" agents={builtin} />
      <AgentTable title="Custom" agents={custom} emptyText="No custom agents yet." />
      {archived.length > 0 && <AgentTable title="Archived" agents={archived} />}

      {showForm && (
        <CustomAgentForm
          onClose={() => setShowForm(false)}
          onCreated={async () => {
            setShowForm(false)
            await router.invalidate()
          }}
        />
      )}
    </div>
  )
}

interface AgentTableProps {
  title: string
  agents: AgentListItem[]
  emptyText?: string
}

function AgentTable({ title, agents, emptyText }: AgentTableProps) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">{title}</h2>
      {agents.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-zinc-200 px-4 py-6">
          <Bot className="size-4 text-zinc-300" strokeWidth={1.75} />
          <p className="text-sm text-zinc-400">{emptyText ?? 'Nothing here yet.'}</p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </ul>
      )}
    </section>
  )
}

function AgentRow({ agent }: { agent: AgentListItem }) {
  const unavailable = agent.status !== 'active'
  return (
    <li className="border-b border-zinc-100 last:border-b-0">
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        className="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-zinc-50"
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="shrink-0 text-sm font-medium text-zinc-900">{agent.name}</span>
          <span className="truncate text-xs text-zinc-500">{agent.purpose ?? 'Custom agent'}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-zinc-400 sm:inline">
            {EXECUTION_TYPE_LABEL[agent.executionType]}
          </span>
          {agent.currentVersion !== null && (
            <span className="hidden text-xs text-zinc-400 sm:inline">v{agent.currentVersion}</span>
          )}
          <Badge tone={unavailable ? 'muted' : 'success'}>{STATUS_LABEL[agent.status]}</Badge>
          <ChevronRight className="size-4 text-zinc-300" strokeWidth={1.75} />
        </div>
      </Link>
    </li>
  )
}
