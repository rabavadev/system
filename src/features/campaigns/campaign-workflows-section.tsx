import { Link, useRouter } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowUpRight,
  ExternalLink,
  Play,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import type { CampaignDetail, CampaignWorkflowRunItem } from '~/server/db/campaign'
import type { WorkflowRunStatus } from '~/types/domain'
import { CampaignWorkflowModal } from './campaign-workflow-modal'

interface CampaignWorkflowsSectionProps {
  campaign: CampaignDetail
  activeWorkflows: Array<{ id: string; name: string; description: string | null }>
  onRefresh?: () => Promise<void> | void
}

function runStatusTone(status: WorkflowRunStatus): 'success' | 'warning' | 'muted' | 'neutral' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'running':
    case 'waiting':
      return 'warning'
    case 'failed':
    case 'cancelled':
    case 'queued':
      return 'muted'
    default:
      return 'neutral'
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return 'Pending'
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return 'Pending'
  }
}

export function CampaignWorkflowsSection({
  campaign,
  activeWorkflows,
  onRefresh,
}: CampaignWorkflowsSectionProps) {
  const router = useRouter()
  const [showWorkflowModal, setShowWorkflowModal] = useState(false)

  const handleRunSuccess = async () => {
    if (onRefresh) {
      await onRefresh()
    } else {
      await router.invalidate()
    }
  }

  const runs = campaign.recentWorkflowRuns ?? []

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <WorkflowIcon className="size-4 text-zinc-500" />
            Campaign Workflows & Execution ({runs.length})
          </h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Manual workflow runs orchestrated with full campaign context and policy-gated tools.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/workflows"
            className="text-xs font-medium text-zinc-500 hover:text-zinc-700 hover:underline inline-flex items-center gap-1"
          >
            All Workflows
            <ExternalLink className="size-3" />
          </Link>
          <Button
            variant="secondary"
            onClick={() => setShowWorkflowModal(true)}
            className="text-xs h-7 px-2.5"
          >
            <Play className="size-3.5 mr-1.5 text-zinc-700" />
            Run workflow
          </Button>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-6 text-center space-y-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 mx-auto">
            <WorkflowIcon className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-800">No workflow runs yet</p>
            <p className="text-xs text-zinc-400 max-w-sm mx-auto">
              Execute active workflows scoped to this campaign. Agent steps receive all campaign
              strategy and target audience parameters automatically.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => setShowWorkflowModal(true)}
            className="text-xs"
          >
            <Play className="size-3.5 mr-1.5 text-zinc-700" />
            Run a Workflow
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100">
          {runs.map((run: CampaignWorkflowRunItem) => (
            <div key={run.id} className="py-3 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      to="/workflows/$workflowId/runs/$runId"
                      params={{ workflowId: run.workflowId, runId: run.id }}
                      className="text-xs font-semibold text-zinc-900 hover:text-blue-600 hover:underline inline-flex items-center gap-1"
                    >
                      {run.workflowName}
                      <ArrowUpRight className="size-3 text-zinc-400" />
                    </Link>
                    <span className="text-[10px] font-mono text-zinc-400">
                      #{run.id.slice(0, 8)}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <span>Started: {formatTime(run.startedAt ?? run.createdAt)}</span>
                    {run.finishedAt && (
                      <>
                        <span>•</span>
                        <span>Finished: {formatTime(run.finishedAt)}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                  <Badge tone={runStatusTone(run.status)}>{run.status.toUpperCase()}</Badge>
                </div>
              </div>

              {/* Waiting for approval alert */}
              {run.status === 'waiting' && (
                <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-900">
                  <div className="flex items-center gap-1.5">
                    <AlertCircle className="size-4 text-amber-600 shrink-0" />
                    <span>
                      Workflow paused: <strong>Waiting for manual approval</strong> on tool action.
                    </span>
                  </div>
                  <Link
                    to="/approvals"
                    className="font-medium text-amber-800 hover:text-amber-950 underline shrink-0 ml-2"
                  >
                    Open Approvals →
                  </Link>
                </div>
              )}

              {run.error && run.status === 'failed' && (
                <div className="rounded border border-red-100 bg-red-50/60 px-2.5 py-1 text-[11px] text-red-700">
                  {run.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showWorkflowModal && (
        <CampaignWorkflowModal
          campaign={campaign}
          activeWorkflows={activeWorkflows}
          onClose={() => setShowWorkflowModal(false)}
          onSuccess={handleRunSuccess}
        />
      )}
    </div>
  )
}
