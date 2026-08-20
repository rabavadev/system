import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  ExternalLink,
  Filter,
  Globe,
  Info,
  Layers,
  MessageSquare,
  Package,
  Send,
  Shield,
  ShieldAlert,
  Tag,
  Workflow,
  X,
} from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import type { ActionKey } from '~/server/policy'

import {
  type ApprovalRequestItem,
  createDevApprovalRequestFn,
  decideApprovalFn,
  getApprovalRequestsOverview,
} from './server'

type ApprovalTab = 'pending' | 'approved' | 'rejected' | 'closed'

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'muted'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'muted',
  cancelled: 'neutral',
  expired: 'muted',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

const RISK_BADGES: Record<string, { label: string; tone: 'warning' | 'neutral' | 'muted' }> = {
  destructive: { label: 'High Risk', tone: 'warning' },
  sensitive: { label: 'Sensitive', tone: 'warning' },
  write: { label: 'Can modify data', tone: 'warning' },
  external: { label: 'Outside service', tone: 'warning' },
  read: { label: 'Read-only', tone: 'neutral' },
}

function getActionIcon(actionKey: string) {
  if (actionKey.startsWith('content.')) return Send
  if (actionKey.startsWith('workflow.')) return Workflow
  if (actionKey.startsWith('memory.')) return MessageSquare
  if (actionKey.startsWith('external.')) return Globe
  if (actionKey.startsWith('destructive.')) return ShieldAlert
  if (actionKey.startsWith('account.')) return Layers
  return Info
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  } catch {
    return isoString
  }
}

function formatExpiryTime(isoString: string | null): string | null {
  if (!isoString) return null
  try {
    const expiry = new Date(isoString)
    const now = new Date()
    const diffMs = expiry.getTime() - now.getTime()
    if (diffMs <= 0) return 'Expired'
    const diffMins = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 60) return `Expires in ${diffMins}m`
    if (diffHours < 24) return `Expires in ${diffHours}h`
    return `Expires in ${diffDays}d`
  } catch {
    return null
  }
}

function renderPayloadValue(val: unknown): string {
  if (val === null || val === undefined) return 'None'
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
  }
  if (typeof val === 'object') {
    return Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('; ')
  }
  return String(val)
}

interface ApprovalCardProps {
  request: ApprovalRequestItem
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onOpenDetails: (request: ApprovalRequestItem) => void
  isProcessing: boolean
}

function ApprovalCard({
  request,
  onApprove,
  onReject,
  onOpenDetails,
  isProcessing,
}: ApprovalCardProps) {
  const Icon = getActionIcon(request.actionKey)
  const isPending = request.status === 'pending'
  const expiryLabel = formatExpiryTime(request.expiresAt)
  const riskInfo = request.risk ? RISK_BADGES[request.risk] : null

  // Extract key payload highlights
  const payloadEntries = Object.entries(request.sanitizedPayload).filter(
    ([k]) => !['brandId', 'workflowId', 'runId', 'stepId'].includes(k),
  )

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 transition-all hover:border-zinc-300 hover:shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
            <Icon className="size-4" strokeWidth={1.75} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-900">{request.actionLabel}</h3>
              <Badge tone={STATUS_TONE[request.status] ?? 'neutral'}>
                {STATUS_LABEL[request.status] ?? request.status}
              </Badge>
              {riskInfo && <Badge tone={riskInfo.tone}>{riskInfo.label}</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-zinc-600">{request.summary}</p>
          </div>
        </div>

        <div className="text-right text-xs text-zinc-400">
          <div>{formatRelativeTime(request.createdAt)}</div>
          {isPending && expiryLabel && (
            <div
              className={`mt-0.5 font-medium ${expiryLabel === 'Expired' ? 'text-red-600' : 'text-amber-600'}`}
            >
              {expiryLabel}
            </div>
          )}
        </div>
      </div>

      {/* Context info bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        <div className="flex items-center gap-1.5">
          <Bot className="size-3.5 text-zinc-400" />
          <span>
            By: <strong className="font-medium text-zinc-800">{request.requesterLabel}</strong>
          </span>
        </div>

        {request.brandName && (
          <div className="flex items-center gap-1.5">
            <Tag className="size-3.5 text-zinc-400" />
            <span>
              Brand: <strong className="font-medium text-zinc-800">{request.brandName}</strong>
            </span>
          </div>
        )}

        {request.workflowName && request.runId && (
          <div className="flex items-center gap-1.5">
            <Workflow className="size-3.5 text-zinc-400" />
            <span>
              Workflow:{' '}
              <Link
                to="/workflows/$workflowId/runs/$runId"
                params={{
                  workflowId: request.workflowId ?? 'unknown',
                  runId: request.runId,
                }}
                className="font-medium text-zinc-800 underline hover:text-zinc-950"
              >
                {request.workflowName}
              </Link>
              {request.stepId && <span className="text-zinc-400"> ({request.stepId})</span>}
            </span>
          </div>
        )}
      </div>

      {/* Preview key parameters */}
      {payloadEntries.length > 0 && (
        <div className="grid grid-cols-1 gap-2 text-xs text-zinc-600 sm:grid-cols-2">
          {payloadEntries.slice(0, 2).map(([key, val]) => (
            <div key={key} className="truncate">
              <span className="text-zinc-400 capitalize">{key.replace(/([A-Z])/g, ' $1')}: </span>
              <span className="font-medium text-zinc-800">{renderPayloadValue(val)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Decision history for resolved requests */}
      {!isPending && (
        <div className="border-t border-zinc-100 pt-2 text-xs text-zinc-500">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {request.decision === 'approved' ? (
                <span className="text-emerald-700 font-medium">✓ Approved</span>
              ) : request.decision === 'rejected' ? (
                <span className="text-red-700 font-medium">✕ Rejected</span>
              ) : (
                <span className="capitalize">{request.status}</span>
              )}
              {request.decidedAt && ` on ${new Date(request.decidedAt).toLocaleString()}`}
            </span>
            {request.decisionNote && (
              <span className="italic text-zinc-600 max-w-md truncate">
                "{request.decisionNote}"
              </span>
            )}
          </div>
        </div>
      )}

      {/* Card Actions Footer */}
      <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
        <Button
          variant="ghost"
          className="h-8 px-2.5 text-xs text-zinc-600 hover:text-zinc-900"
          onClick={() => onOpenDetails(request)}
        >
          View details
          <ArrowRight className="size-3.5 ml-1" />
        </Button>

        {isPending && (
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              className="h-8 text-xs"
              onClick={() => onReject(request.id)}
              disabled={isProcessing}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => onApprove(request.id)}
              disabled={isProcessing}
            >
              {isProcessing ? 'Processing…' : 'Approve'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

interface DetailModalProps {
  request: ApprovalRequestItem
  onClose: () => void
  onApprove: (id: string, note?: string) => void
  onReject: (id: string, note: string) => void
  onCancel: (id: string, note?: string) => void
  isProcessing: boolean
}

function ApprovalDetailModal({
  request,
  onClose,
  onApprove,
  onReject,
  onCancel,
  isProcessing,
}: DetailModalProps) {
  const [decisionNote, setDecisionNote] = useState('')
  const isPending = request.status === 'pending'
  const Icon = getActionIcon(request.actionKey)
  const riskInfo = request.risk ? RISK_BADGES[request.risk] : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.actionLabel}
        className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white shadow-xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
              <Icon className="size-5" strokeWidth={1.75} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-900">{request.actionLabel}</h2>
                <Badge tone={STATUS_TONE[request.status] ?? 'neutral'}>
                  {STATUS_LABEL[request.status] ?? request.status}
                </Badge>
              </div>
              <p className="text-xs text-zinc-500">{request.summary}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
          {/* Section 1: What will happen */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-600 mb-3 flex items-center gap-1.5">
              <Package className="size-3.5" />
              Proposed Action Parameters
            </h4>
            <div className="space-y-2.5">
              {Object.entries(request.sanitizedPayload).map(([key, val]) => (
                <div
                  key={key}
                  className="flex flex-col sm:flex-row sm:items-baseline gap-1 text-xs"
                >
                  <span className="w-36 shrink-0 font-medium text-zinc-500 capitalize">
                    {key.replace(/([A-Z])/g, ' $1')}:
                  </span>
                  <span className="flex-1 font-mono text-zinc-900 break-words bg-white rounded px-2 py-1 border border-zinc-200">
                    {renderPayloadValue(val)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Section 2: Why it was requested & Risk */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 p-3.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5">
                <Info className="size-3.5" />
                Policy & Requester
              </h4>
              <div className="space-y-1.5 text-xs text-zinc-700">
                <div>
                  <span className="text-zinc-400">Requested by: </span>
                  <strong>{request.requesterLabel}</strong>
                </div>
                <div>
                  <span className="text-zinc-400">Policy Reason: </span>
                  <span>{request.reason}</span>
                </div>
                <div>
                  <span className="text-zinc-400">Requested at: </span>
                  <span>{new Date(request.createdAt).toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-200 p-3.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5">
                <Shield className="size-3.5" />
                Security & Risk
              </h4>
              <div className="space-y-1.5 text-xs text-zinc-700">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400">Risk rating:</span>
                  {riskInfo ? (
                    <Badge tone={riskInfo.tone}>{riskInfo.label}</Badge>
                  ) : (
                    <Badge tone="neutral">Standard</Badge>
                  )}
                </div>
                {request.expiresAt && (
                  <div>
                    <span className="text-zinc-400">Expires: </span>
                    <span>{new Date(request.expiresAt).toLocaleString()}</span>
                  </div>
                )}
                <div>
                  <span className="text-zinc-400">Authority Gate: </span>
                  <span>Human user only</span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Workflow Linkage */}
          {request.workflowName && request.runId && (
            <div className="rounded-lg border border-zinc-200 p-3.5 bg-blue-50/40">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-blue-900 mb-2 flex items-center gap-1.5">
                <Workflow className="size-3.5 text-blue-700" />
                Linked Workflow Run
              </h4>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-700">
                <div>
                  <div>
                    Workflow: <strong>{request.workflowName}</strong> (Step:{' '}
                    <code>{request.stepId}</code>)
                  </div>
                  <div className="text-zinc-500 mt-0.5">
                    Run Status: <span className="capitalize font-medium">{request.runStatus}</span>
                  </div>
                </div>
                <Link
                  to="/workflows/$workflowId/runs/$runId"
                  params={{
                    workflowId: request.workflowId ?? 'unknown',
                    runId: request.runId,
                  }}
                  className="inline-flex items-center gap-1 rounded bg-white px-2.5 py-1 text-xs font-medium text-blue-700 border border-blue-200 hover:bg-blue-50"
                >
                  Open Workflow Run
                  <ExternalLink className="size-3" />
                </Link>
              </div>
            </div>
          )}

          {/* Section 4: Decision History (if decided) */}
          {!isPending && (
            <div className="rounded-lg border border-zinc-200 p-3.5 bg-zinc-50">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5">
                <Clock className="size-3.5" />
                Decision History
              </h4>
              <div className="space-y-1.5 text-xs text-zinc-700">
                <div>
                  <span className="text-zinc-400">Decision: </span>
                  <span className="font-semibold capitalize">
                    {request.decision ?? request.status}
                  </span>
                </div>
                {request.decidedAt && (
                  <div>
                    <span className="text-zinc-400">Decided at: </span>
                    <span>{new Date(request.decidedAt).toLocaleString()}</span>
                  </div>
                )}
                {request.decisionNote && (
                  <div>
                    <span className="text-zinc-400">Note: </span>
                    <span className="italic">"{request.decisionNote}"</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Section 5: Decision note input when pending */}
          {isPending && (
            <div className="space-y-2 border-t border-zinc-100 pt-4">
              <label htmlFor="decision-note" className="block text-xs font-medium text-zinc-700">
                Decision note (optional)
              </label>
              <textarea
                id="decision-note"
                rows={2}
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Add optional notes or rationale for this decision…"
                className="w-full rounded-md border border-zinc-300 p-2 text-xs text-zinc-900 focus:border-zinc-500 focus:outline-hidden"
              />
            </div>
          )}

          {/* Dev Only: Technical Details */}
          {import.meta.env.DEV && (
            <details className="text-xs text-zinc-400 pt-2 border-t border-zinc-100">
              <summary className="cursor-pointer font-medium hover:text-zinc-600">
                Developer Trace & Snapshot Fingerprint
              </summary>
              <div className="mt-2 space-y-1 rounded bg-zinc-100 p-2.5 font-mono text-[11px] text-zinc-700">
                <div>Fingerprint: {request.fingerprint}</div>
                <div>Request ID: {request.id}</div>
                <div className="mt-1">
                  Raw Snapshot:
                  <pre className="max-h-32 overflow-auto bg-white p-1 rounded mt-0.5 text-zinc-800">
                    {request.snapshotJson}
                  </pre>
                </div>
              </div>
            </details>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-zinc-100 px-6 py-4 bg-zinc-50 rounded-b-xl">
          <Button variant="ghost" onClick={onClose} className="text-xs">
            Close
          </Button>

          {isPending && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                className="text-xs text-zinc-500 hover:text-zinc-800"
                onClick={() => onCancel(request.id, decisionNote)}
                disabled={isProcessing}
              >
                Cancel request
              </Button>
              <Button
                variant="danger"
                className="text-xs"
                onClick={() => onReject(request.id, decisionNote)}
                disabled={isProcessing}
              >
                Reject
              </Button>
              <Button
                variant="primary"
                className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-4"
                onClick={() => onApprove(request.id, decisionNote)}
                disabled={isProcessing}
              >
                {isProcessing ? 'Processing…' : 'Approve'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ApprovalsPage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<ApprovalTab>('pending')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [selectedDetailRequest, setSelectedDetailRequest] = useState<ApprovalRequestItem | null>(
    null,
  )
  const [actionFeedback, setActionFeedback] = useState<{
    tone: 'success' | 'warning' | 'neutral'
    message: string
  } | null>(null)

  // Dev simulator state
  const [simActionKey, setSimActionKey] = useState<ActionKey>('content.publish')

  const overview = useQuery({
    queryKey: ['approvals-overview'],
    queryFn: () => getApprovalRequestsOverview({ data: {} }),
  })

  const decideMutation = useMutation({
    mutationFn: (vars: {
      requestId: string
      decision: 'approved' | 'rejected' | 'cancelled'
      note?: string
    }) =>
      decideApprovalFn({
        data: {
          requestId: vars.requestId,
          decision: vars.decision,
          note: vars.note || null,
        },
      }),
    onSuccess: (result, vars) => {
      queryClient.invalidateQueries({ queryKey: ['approvals-overview'] })
      queryClient.invalidateQueries({ queryKey: ['shell-data'] })
      setSelectedDetailRequest(null)

      if (vars.decision === 'approved') {
        if (result.resumeResult?.ok) {
          setActionFeedback({
            tone: 'success',
            message: '✓ Approved — linked workflow resumed successfully.',
          })
        } else if (result.resumeResult && !result.resumeResult.ok) {
          setActionFeedback({
            tone: 'warning',
            message: `Approved, but workflow resume failed: ${result.resumeResult.message ?? 'Unknown error'}`,
          })
        } else {
          setActionFeedback({
            tone: 'success',
            message: '✓ Action approved successfully.',
          })
        }
      } else if (vars.decision === 'rejected') {
        setActionFeedback({
          tone: 'neutral',
          message: 'Request was rejected.',
        })
      } else {
        setActionFeedback({
          tone: 'neutral',
          message: 'Request was cancelled.',
        })
      }
    },
    onError: (err) => {
      setActionFeedback({
        tone: 'warning',
        message: err instanceof Error ? err.message : 'Action failed',
      })
    },
  })

  const createSimMutation = useMutation({
    mutationFn: () =>
      createDevApprovalRequestFn({
        data: {
          actionKey: simActionKey,
          origin: 'agent',
          summary: `Proposed action for ${simActionKey}`,
          payload: {
            title: 'Sample Action Item',
            target: 'Platform connection',
            notes: 'Generated via simulator for review testing.',
            timestamp: new Date().toISOString(),
          },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approvals-overview'] })
      setActiveTab('pending')
      setActionFeedback({
        tone: 'success',
        message: 'Simulated approval request created.',
      })
    },
  })

  const allRequests: ApprovalRequestItem[] = overview.data?.requests ?? []
  const pendingCount = overview.data?.pendingCount ?? 0

  // Filter requests according to active tab
  const tabFilteredRequests = allRequests.filter((req: ApprovalRequestItem) => {
    if (activeTab === 'pending') return req.status === 'pending'
    if (activeTab === 'approved') return req.status === 'approved'
    if (activeTab === 'rejected') return req.status === 'rejected'
    if (activeTab === 'closed') return req.status === 'cancelled' || req.status === 'expired'
    return true
  })

  // Filter by category
  const filteredRequests = tabFilteredRequests.filter((req: ApprovalRequestItem) => {
    if (selectedCategory === 'all') return true
    return req.actionCategory === selectedCategory
  })

  const handleApprove = (id: string, note?: string) => {
    decideMutation.mutate({
      requestId: id,
      decision: 'approved',
      ...(note ? { note } : {}),
    })
  }

  const handleReject = (id: string, note = '') => {
    decideMutation.mutate({
      requestId: id,
      decision: 'rejected',
      ...(note ? { note } : {}),
    })
  }

  const handleCancel = (id: string, note?: string) => {
    decideMutation.mutate({
      requestId: id,
      decision: 'cancelled',
      ...(note ? { note } : {}),
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Approval Center"
        description="Review and authorize concrete actions waiting for human authorization."
      />

      {/* Action feedback toast / banner */}
      {actionFeedback && (
        <div
          className={`flex items-center justify-between rounded-lg px-4 py-3 text-xs font-medium ${
            actionFeedback.tone === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : actionFeedback.tone === 'warning'
                ? 'bg-amber-50 text-amber-800 border border-amber-200'
                : 'bg-zinc-100 text-zinc-800 border border-zinc-200'
          }`}
        >
          <span>{actionFeedback.message}</span>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="text-zinc-400 hover:text-zinc-700"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Safety Notice */}
      <div className="flex items-start gap-2.5 rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs text-blue-900">
        <Shield className="size-4 shrink-0 text-blue-600 mt-0.5" />
        <div>
          <span className="font-semibold">Human Authority Gate:</span> Only human operators can
          authorize these actions. AI Agents, Chief, and Tools cannot self-approve.
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-zinc-200 pb-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('pending')}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'pending'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'
            }`}
          >
            Needs Review
            {pendingCount > 0 && (
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] font-bold ${
                  activeTab === 'pending'
                    ? 'bg-amber-500 text-white'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {pendingCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('approved')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'approved'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'
            }`}
          >
            Approved
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('rejected')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'rejected'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'
            }`}
          >
            Rejected
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('closed')}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'closed'
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'
            }`}
          >
            Expired / Cancelled
          </button>
        </div>

        {/* Category Filter */}
        <div className="flex items-center gap-2">
          <Filter className="size-3.5 text-zinc-400" />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="rounded border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-800 focus:border-zinc-400 focus:outline-hidden"
          >
            <option value="all">All Categories</option>
            <option value="content">Publishing & Content</option>
            <option value="workflow">Workflows</option>
            <option value="external">Outside Services</option>
            <option value="memory">Learned Memory</option>
            <option value="read">Research & Read</option>
            <option value="system">System & Data</option>
          </select>
        </div>
      </div>

      {/* Main Request List */}
      {filteredRequests.length === 0 ? (
        <EmptyState
          icon={activeTab === 'pending' ? CheckCircle2 : Clock}
          title={activeTab === 'pending' ? 'Nothing needs your review' : 'No requests in this view'}
          description={
            activeTab === 'pending'
              ? 'All automated actions are executing smoothly or paused according to your policy.'
              : 'Requests will appear here as they are processed by your team.'
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {filteredRequests.map((req) => (
            <ApprovalCard
              key={req.id}
              request={req}
              onApprove={(id) => handleApprove(id)}
              onReject={() => {
                setSelectedDetailRequest(req)
              }}
              onOpenDetails={(item) => setSelectedDetailRequest(item)}
              isProcessing={decideMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Dev Simulator Bar */}
      {import.meta.env.DEV && (
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-700">
              Dev Request Simulator
            </div>
            <div className="text-xs text-zinc-500">
              Test creating an action request through the STEP 11A–11C policy engine.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={simActionKey}
              onChange={(e) => setSimActionKey(e.target.value as ActionKey)}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800"
            >
              <option value="content.publish">content.publish</option>
              <option value="workflow.run">workflow.run</option>
              <option value="workflow.create">workflow.create</option>
              <option value="memory.verify">memory.verify</option>
              <option value="external.write">external.write</option>
              <option value="account.modify">account.modify</option>
              <option value="destructive.delete">destructive.delete</option>
              <option value="workspace.read">workspace.read</option>
            </select>
            <Button
              variant="secondary"
              onClick={() => createSimMutation.mutate()}
              disabled={createSimMutation.isPending}
              className="text-xs"
            >
              {createSimMutation.isPending ? 'Submitting…' : 'Simulate Request'}
            </Button>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {selectedDetailRequest && (
        <ApprovalDetailModal
          request={selectedDetailRequest}
          onClose={() => setSelectedDetailRequest(null)}
          onApprove={(id, note) => handleApprove(id, note)}
          onReject={(id, note) => handleReject(id, note)}
          onCancel={(id, note) => handleCancel(id, note)}
          isProcessing={decideMutation.isPending}
        />
      )}
    </div>
  )
}
