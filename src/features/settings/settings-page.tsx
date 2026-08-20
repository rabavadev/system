import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { CAPABILITY_LABEL } from '~/features/agents/labels'
import type { ActionKey, PolicyMode, PolicyResolutionResult } from '~/server/policy'

import {
  type AutonomyOverviewItem,
  clearPolicyOverrideFn,
  getAutonomyOverview,
  getChiefStatus,
  getPolicyTraceFn,
  getToolsOverview,
  setPolicyFn,
  type ToolOverviewItem,
} from './server'

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

const MODE_TONE: Record<PolicyMode, 'success' | 'warning' | 'muted'> = {
  auto: 'success',
  review: 'warning',
  blocked: 'muted',
}

const MODE_OPTIONS: Array<{ value: PolicyMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'review', label: 'Review first' },
  { value: 'blocked', label: 'Blocked' },
]

function PolicyRow({
  item,
  scopeType,
  scopeId: _scopeId,
  onSetMode,
  onClearOverride,
  isMutating,
}: {
  item: AutonomyOverviewItem
  scopeType: 'workspace' | 'brand'
  scopeId: string
  onSetMode: (key: ActionKey, mode: PolicyMode) => void
  onClearOverride: (key: ActionKey) => void
  isMutating: boolean
}) {
  const currentMode =
    scopeType === 'brand' ? (item.brandOverrideMode ?? item.workspaceMode) : item.workspaceMode
  const isOverridden = scopeType === 'brand' && item.brandOverrideMode !== null

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-100 py-3.5 first:border-t-0 md:flex-row md:items-center md:justify-between">
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-900">{item.label}</span>
          {scopeType === 'brand' ? (
            isOverridden ? (
              <Badge tone="warning">Brand override</Badge>
            ) : (
              <Badge tone="neutral">Inherited</Badge>
            )
          ) : item.isWorkspaceCustom ? (
            <Badge tone="neutral">Workspace policy</Badge>
          ) : (
            <Badge tone="neutral">System default</Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">{item.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-zinc-200 bg-zinc-50 p-0.5 shadow-xs">
          {MODE_OPTIONS.map((opt) => {
            const isSelected = currentMode === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                disabled={isMutating}
                onClick={() => onSetMode(item.key, opt.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-all ${
                  isSelected
                    ? opt.value === 'auto'
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : opt.value === 'review'
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'bg-red-600 text-white shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-900'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        {scopeType === 'brand' && isOverridden && (
          <Button
            variant="ghost"
            className="text-xs text-zinc-500 hover:text-zinc-800"
            disabled={isMutating}
            onClick={() => onClearOverride(item.key)}
          >
            Use workspace default
          </Button>
        )}
      </div>
    </div>
  )
}

function PolicyTraceInspector({
  workspaceId: _workspaceId,
  selectedBrandId,
  items,
}: {
  workspaceId: string
  selectedBrandId: string | null
  items: AutonomyOverviewItem[]
}) {
  const [actionKey, setActionKey] = useState<ActionKey>(items[0]?.key ?? 'content.publish')
  const [traceResult, setTraceResult] = useState<PolicyResolutionResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleRunTrace = async () => {
    setIsLoading(true)
    try {
      const res = await getPolicyTraceFn({
        data: {
          actionKey,
          brandId: selectedBrandId,
        },
      })
      setTraceResult(res)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-xs font-semibold text-zinc-900 uppercase tracking-wider">
            Policy Resolver Trace (Dev)
          </h3>
          <p className="text-xs text-zinc-500">
            Simulate step-by-step policy resolution for the selected scope.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={actionKey}
            onChange={(e) => setActionKey(e.target.value as ActionKey)}
            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900"
          >
            {items.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label} ({i.key})
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={handleRunTrace} disabled={isLoading}>
            {isLoading ? 'Tracing…' : 'Run Trace'}
          </Button>
        </div>
      </div>

      {traceResult && (
        <div className="mt-4 space-y-2 border-t border-zinc-200 pt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-600 font-medium">
              Action: <code className="text-zinc-900">{traceResult.action}</code>
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Resolved:</span>
              <Badge tone={MODE_TONE[traceResult.mode]}>{traceResult.mode.toUpperCase()}</Badge>
            </div>
          </div>
          <div className="text-xs text-zinc-600">
            Reason: <span className="font-medium text-zinc-900">{traceResult.reason}</span> (Source:{' '}
            <code className="text-zinc-800">{traceResult.source}</code>)
          </div>
          <div className="mt-2 space-y-1.5">
            <div className="text-[11px] font-semibold text-zinc-500 uppercase">
              Evaluation Steps
            </div>
            {traceResult.trace.steps.map((s) => (
              <div
                key={`trace-${s.step}-${s.detail}`}
                className="flex items-start gap-2 rounded bg-white p-2 text-xs border border-zinc-200"
              >
                <Badge tone={s.matched ? 'success' : 'neutral'}>
                  {s.matched ? 'MATCH' : 'SKIP'}
                </Badge>
                <div className="flex-1">
                  <span className="font-medium text-zinc-800">{s.step}</span>
                  <p className="text-zinc-500 text-[11px]">{s.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['chief-status'], queryFn: () => getChiefStatus() })
  const tools = useQuery({ queryKey: ['tools-overview'], queryFn: () => getToolsOverview() })

  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null)
  const scopeType = selectedBrandId ? 'brand' : 'workspace'

  const autonomy = useQuery({
    queryKey: ['autonomy-overview', selectedBrandId],
    queryFn: () => getAutonomyOverview({ data: { brandId: selectedBrandId } }),
  })

  const setPolicyMutation = useMutation({
    mutationFn: (vars: { key: ActionKey; mode: PolicyMode }) => {
      if (!autonomy.data) throw new Error('No data')
      const targetScopeId = selectedBrandId ?? autonomy.data.workspaceId
      return setPolicyFn({
        data: {
          scopeType,
          scopeId: targetScopeId,
          actionKey: vars.key,
          mode: vars.mode,
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autonomy-overview'] })
    },
  })

  const clearOverrideMutation = useMutation({
    mutationFn: (key: ActionKey) => {
      if (!selectedBrandId) throw new Error('No brand selected')
      return clearPolicyOverrideFn({
        data: {
          scopeId: selectedBrandId,
          actionKey: key,
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autonomy-overview'] })
    },
  })

  const isMutating = setPolicyMutation.isPending || clearOverrideMutation.isPending

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader title="Settings" description="Workspace and autonomy configuration." />

      {/* Autonomy (Approval Policy) Section */}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Autonomy & Approval Policy</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Control what runs automatically, what requires human review first, and what is
              blocked.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Scope:</span>
            <select
              value={selectedBrandId ?? ''}
              onChange={(e) => setSelectedBrandId(e.target.value ? e.target.value : null)}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
            >
              <option value="">Workspace Defaults</option>
              {autonomy.data?.brands.map((b) => (
                <option key={b.id} value={b.id}>
                  Brand: {b.name} (Override)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Mode Explanations */}
        <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-zinc-50 p-3 text-xs sm:grid-cols-3">
          <div>
            <span className="font-semibold text-emerald-700">Auto:</span>{' '}
            <span className="text-zinc-600">
              The system may perform this when otherwise allowed.
            </span>
          </div>
          <div>
            <span className="font-semibold text-amber-700">Review first:</span>{' '}
            <span className="text-zinc-600">You approve each action before it happens.</span>
          </div>
          <div>
            <span className="font-semibold text-red-700">Blocked:</span>{' '}
            <span className="text-zinc-600">The system cannot perform this autonomously.</span>
          </div>
        </div>

        {/* Safety Note */}
        <p className="mt-2 text-[11px] text-zinc-400">
          * Security restrictions, missing permissions, and unavailable integrations still prevent
          actions even when Auto is enabled.
        </p>

        <div className="mt-4 divide-y divide-zinc-100">
          {autonomy.data?.items.map((item) => (
            <PolicyRow
              key={item.key}
              item={item}
              scopeType={scopeType}
              scopeId={selectedBrandId ?? autonomy.data.workspaceId}
              onSetMode={(key, mode) => setPolicyMutation.mutate({ key, mode })}
              onClearOverride={(key) => clearOverrideMutation.mutate(key)}
              isMutating={isMutating}
            />
          ))}
        </div>

        {autonomy.data && (
          <PolicyTraceInspector
            workspaceId={autonomy.data.workspaceId}
            selectedBrandId={selectedBrandId}
            items={autonomy.data.items}
          />
        )}
      </section>

      {/* Chief Section */}
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

      {/* Tools Section */}
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
