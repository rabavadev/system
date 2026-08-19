import { getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { Bot, MessageSquare, Pencil } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { createConversationFn } from '~/features/chat/server'

import { AgentVersionForm } from './agent-version-form'
import { CAPABILITY_LABEL, EXECUTION_TYPE_LABEL, STATUS_LABEL, STRATEGY_LABEL } from './labels'
import { type AgentDetailData, archiveAgentFn, setAgentStatusFn } from './server'

const routeApi = getRouteApi('/agents_/$agentId')

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

export function AgentDetailPage() {
  const data = routeApi.useLoaderData() as AgentDetailData
  const router = useRouter()
  const navigate = useNavigate()
  const [showEdit, setShowEdit] = useState(false)
  const [pending, startTransition] = useTransition()
  const { agent, versions } = data
  const current = versions.find((version) => version.isCurrent) ?? null

  function setStatus(status: 'active' | 'disabled') {
    startTransition(async () => {
      await setAgentStatusFn({ data: { id: agent.id, status } })
      await router.invalidate()
    })
  }

  function archive() {
    startTransition(async () => {
      await archiveAgentFn({ data: { id: agent.id } })
      await router.invalidate()
      await navigate({ to: '/agents' })
    })
  }

  function chatWithAgent() {
    startTransition(async () => {
      const { id } = await createConversationFn({ data: {} })
      await navigate({
        to: '/chat/$conversationId',
        params: { conversationId: id },
        search: { agent: agent.id },
      })
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title={agent.name}
        description={agent.purpose ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            {agent.status === 'active' && agent.executionType === 'direct_model' && (
              <Button variant="secondary" onClick={chatWithAgent} disabled={pending}>
                <MessageSquare className="size-4" strokeWidth={1.75} />
                Chat
              </Button>
            )}
            <Button variant="secondary" onClick={() => setShowEdit(true)}>
              <Pencil className="size-4" strokeWidth={1.75} />
              Edit
            </Button>
            {agent.status === 'disabled' ? (
              <Button variant="secondary" onClick={() => setStatus('active')} disabled={pending}>
                Enable
              </Button>
            ) : agent.status === 'active' ? (
              <Button variant="secondary" onClick={() => setStatus('disabled')} disabled={pending}>
                Disable
              </Button>
            ) : null}
            {agent.origin === 'custom' && agent.status !== 'archived' && (
              <Button variant="danger" onClick={archive} disabled={pending}>
                Archive
              </Button>
            )}
          </div>
        }
      />

      <section className="flex flex-wrap items-center gap-2">
        <Badge tone={agent.status === 'active' ? 'success' : 'muted'}>
          {STATUS_LABEL[agent.status]}
        </Badge>
        <Badge tone="neutral">{EXECUTION_TYPE_LABEL[agent.executionType]}</Badge>
        {agent.origin === 'builtin' && <Badge tone="muted">Built-in</Badge>}
        {current && <Badge tone="neutral">Version {current.version}</Badge>}
        {current && (
          <Badge tone="muted">
            {STRATEGY_LABEL[current.modelStrategy] ?? current.modelStrategy} model
          </Badge>
        )}
      </section>

      {agent.executionType !== 'direct_model' && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {agent.executionType === 'external_agent'
            ? 'This agent needs a connection before it can run. External execution is not enabled yet.'
            : 'Smart routing is not enabled yet. This agent cannot run for now.'}
        </p>
      )}

      {current && current.capabilities.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
            Capabilities
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {current.capabilities.map((capability) => (
              <Badge key={capability} tone="neutral">
                {CAPABILITY_LABEL[capability] ?? capability}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-zinc-400">
            Capabilities describe what an agent is meant to do once tools exist. They do not grant
            any real actions yet.
          </p>
        </section>
      )}

      {current?.external && (
        <section className="flex flex-col gap-1.5">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Connection</h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-zinc-500">Endpoint</dt>
            <dd className="text-zinc-800">{current.external.endpoint ?? 'Not set'}</dd>
            <dt className="text-zinc-500">Agent reference</dt>
            <dd className="text-zinc-800">{current.external.agentRef ?? 'Not set'}</dd>
            <dt className="text-zinc-500">Credential</dt>
            <dd className="text-zinc-800">
              {current.external.hasCredential ? 'Referenced (stored outside the app)' : 'Not set'}
            </dd>
          </dl>
        </section>
      )}

      {current && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
            Current instructions
          </h2>
          <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
            <p className="text-sm whitespace-pre-wrap text-zinc-700">{current.instructions}</p>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
          Version history
        </h2>
        <ul className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          {versions.map((version) => (
            <VersionRow key={version.id} version={version} />
          ))}
        </ul>
        <p className="text-xs text-zinc-400">
          Versions are never rewritten. Editing saves a new version; past conversations keep the
          version that answered them.
        </p>
      </section>

      {showEdit && current && (
        <AgentVersionForm
          agentId={agent.id}
          current={current}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false)
            await router.invalidate()
          }}
        />
      )}
    </div>
  )
}

function VersionRow({ version }: { version: AgentDetailData['versions'][number] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className="border-b border-zinc-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-zinc-900">
          <Bot className="size-3.5 text-zinc-400" strokeWidth={1.75} />
          Version {version.version}
        </span>
        {version.isCurrent && <Badge tone="success">Current</Badge>}
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
          {version.changeNote ?? ''}
        </span>
        <time dateTime={version.createdAt} className="shrink-0 text-xs text-zinc-400">
          {dateFormat.format(new Date(version.createdAt))}
        </time>
      </button>
      {expanded && (
        <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3">
          <p className="text-xs whitespace-pre-wrap text-zinc-600">{version.instructions}</p>
        </div>
      )}
    </li>
  )
}
