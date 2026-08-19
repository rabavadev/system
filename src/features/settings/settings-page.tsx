import { useQuery } from '@tanstack/react-query'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { CAPABILITY_LABEL } from '~/features/agents/labels'

import { getChiefStatus, getToolsOverview, type ToolOverviewItem } from './server'

const CATEGORY_LABEL: Record<string, string> = {
  workspace: 'Workspace',
  memory: 'Memory',
  research: 'Research',
  files: 'Files',
  web: 'Web',
  content: 'Content',
  analytics: 'Analytics',
  media: 'Media',
  platform: 'Platforms',
  system: 'System',
}

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  disabled: 'Off',
  needs_setup: 'Needs setup',
  unavailable: 'Not available',
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'muted' | 'neutral'> = {
  available: 'success',
  disabled: 'muted',
  needs_setup: 'warning',
  unavailable: 'muted',
}

const RISK_LABEL: Record<string, string> = {
  read: 'Can read',
  write: 'Can change',
  external: 'Uses outside service',
  sensitive: 'Sensitive',
  destructive: 'Can delete',
}

function ToolRow({ tool }: { tool: ToolOverviewItem }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-t border-zinc-100 py-3 first:border-t-0 md:grid-cols-[1.2fr_1.6fr_0.8fr_0.8fr_1fr] md:items-start">
      <div>
        <div className="text-sm font-medium text-zinc-900">{tool.name}</div>
        <div className="text-xs text-zinc-400">
          {CATEGORY_LABEL[tool.category] ?? tool.category}
        </div>
      </div>
      <div className="text-sm text-zinc-600">
        {tool.description}
        <div className="mt-1 text-xs text-zinc-400">
          Needs: {CAPABILITY_LABEL[tool.requiredCapability] ?? tool.requiredCapability}
        </div>
      </div>
      <div>
        <Badge tone={STATUS_TONE[tool.status] ?? 'neutral'}>
          {STATUS_LABEL[tool.status] ?? tool.status}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1">
        {tool.risk.map((risk) => (
          <Badge key={risk} tone={risk === 'read' ? 'neutral' : 'warning'}>
            {RISK_LABEL[risk] ?? risk}
          </Badge>
        ))}
      </div>
      <div className="text-sm text-zinc-600">
        {tool.usedBy.length > 0 ? tool.usedBy.join(', ') : 'No one yet'}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const status = useQuery({ queryKey: ['chief-status'], queryFn: () => getChiefStatus() })
  const tools = useQuery({ queryKey: ['tools-overview'], queryFn: () => getToolsOverview() })

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader title="Settings" description="Workspace configuration." />

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">Chief (workspace AI)</h2>
          {status.data ? (
            <Badge tone={status.data.configured ? 'success' : 'warning'}>
              {status.data.configured ? 'Connected' : 'Not configured'}
            </Badge>
          ) : (
            <Badge tone="muted">Checking…</Badge>
          )}
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          {status.data ? status.data.detail : 'Checking whether Chief can reach a model.'}
        </p>
        {status.data && !status.data.configured && (
          <p className="mt-1 text-xs text-zinc-400">
            Setup lives in docs/ai-execution.md. Credentials are never shown here.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Tools</h2>
        <p className="mt-1 text-sm text-zinc-600">
          What agents are allowed to use. Availability, permission and approval are separate.
        </p>
        <div className="mt-3 hidden grid-cols-[1.2fr_1.6fr_0.8fr_0.8fr_1fr] gap-2 text-xs font-medium text-zinc-400 md:grid">
          <span>Tool</span>
          <span>Purpose</span>
          <span>Status</span>
          <span>Risk</span>
          <span>Used by</span>
        </div>
        <div className="divide-y divide-zinc-100">
          {(tools.data?.tools ?? []).map((tool) => (
            <ToolRow key={tool.key} tool={tool} />
          ))}
        </div>
        {tools.data && tools.data.tools.length === 0 && (
          <p className="mt-3 text-sm text-zinc-500">No tools are registered yet.</p>
        )}
      </section>
    </div>
  )
}
