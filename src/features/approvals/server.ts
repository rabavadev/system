import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { resolveAiRuntime } from '~/server/ai/runtime'
import {
  type ApprovalRequestRecord,
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalWithExpiryCheck,
} from '~/server/approval'
import { getAgentById } from '~/server/db/agent'
import { countPendingApprovals, listApprovalRequests } from '~/server/db/approval'
import { listBrands } from '~/server/db/brand'
import { getDb } from '~/server/db/client'
import type { SqlDatabase } from '~/server/db/sql'
import { getWorkflowById, getWorkflowRunById } from '~/server/db/workflow'
import { getDefaultWorkspace } from '~/server/db/workspace'
import { ACTION_DEFINITIONS, ACTION_KEYS, type ActionKey } from '~/server/policy'
import { resumeWorkflowAfterApproval } from '~/server/workflows'

export interface ApprovalRequestItem {
  id: string
  workspaceId: string
  actionKey: string
  actionLabel: string
  actionCategory: string
  origin: string
  requestedByType: string
  requestedById: string | null
  requesterLabel: string
  subjectType: string | null
  subjectId: string | null
  summary: string
  reason: string
  resolvedMode: string
  policySource: string
  risks: string[]
  risk: string | null
  sanitizedPayload: Record<string, string>
  snapshotJson: string
  fingerprint: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
  expiresAt: string | null
  decision: 'approved' | 'rejected' | 'cancelled' | 'expired' | null
  decidedByType: 'user' | 'system' | null
  decidedById: string | null
  decisionNote: string | null
  decidedAt: string | null
  workflowId: string | null
  workflowName: string | null
  runId: string | null
  runStatus: string | null
  stepId: string | null
  brandId: string | null
  brandName: string | null
  createdAt: string
  updatedAt: string
}

export interface ApprovalsOverview {
  workspaceId: string
  pendingCount: number
  requests: ApprovalRequestItem[]
}

export interface DecideApprovalResult {
  record: ApprovalRequestRecord
  resumeResult?: { ok: boolean; message?: string } | null
}

async function enrichApprovalRecord(
  db: SqlDatabase,
  record: ApprovalRequestRecord,
  brandsMap: Map<string, string>,
): Promise<ApprovalRequestItem> {
  const actionDef = ACTION_DEFINITIONS[record.actionKey as ActionKey]
  const actionLabel = actionDef?.label ?? record.actionKey
  const actionCategory = actionDef?.category ?? 'system'

  let workflowName: string | null = null
  let runStatus: string | null = null
  let agentName: string | null = null

  if (record.workflowId) {
    try {
      const wf = await getWorkflowById(db, record.workflowId)
      if (wf) workflowName = wf.name
    } catch {
      // safe fallback
    }
  }

  if (record.runId) {
    try {
      const run = await getWorkflowRunById(db, record.runId)
      if (run) runStatus = run.status
    } catch {
      // safe fallback
    }
  }

  if (record.requestedByType === 'agent' && record.requestedById) {
    try {
      const agent = await getAgentById(db, record.requestedById)
      if (agent) agentName = agent.name
    } catch {
      // safe fallback
    }
  }

  let requesterLabel = 'System'
  if (record.origin === 'chief' || record.requestedByType === 'chief') {
    requesterLabel = 'Workspace Chief'
  } else if (record.origin === 'user' || record.requestedByType === 'user') {
    requesterLabel = 'Human User'
  } else if (record.origin === 'agent' || record.requestedByType === 'agent') {
    requesterLabel = agentName ? `Agent: ${agentName}` : 'AI Agent'
  } else if (record.origin === 'workflow' || record.requestedByType === 'workflow') {
    requesterLabel = workflowName ? `Workflow: ${workflowName}` : 'Workflow Engine'
  } else if (record.origin === 'tool') {
    requesterLabel = 'Tool Step'
  }

  const sanitizedPayload: Record<string, string> = {}
  let brandIdFromPayload: string | undefined
  try {
    const parsed = JSON.parse(record.snapshotJson || '{}') as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === undefined) {
        sanitizedPayload[k] = 'None'
      } else if (typeof v === 'string') {
        sanitizedPayload[k] = v
        if (k === 'brandId') brandIdFromPayload = v
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        sanitizedPayload[k] = String(v)
      } else {
        sanitizedPayload[k] = JSON.stringify(v)
      }
    }
  } catch {
    // safe fallback
  }

  const brandId = brandIdFromPayload ?? (record.subjectType === 'brand' ? record.subjectId : null)
  const brandName = brandId ? (brandsMap.get(brandId) ?? null) : null

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    actionKey: record.actionKey,
    actionLabel,
    actionCategory,
    origin: record.origin,
    requestedByType: record.requestedByType,
    requestedById: record.requestedById,
    requesterLabel,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    summary: record.summary,
    reason: record.reason,
    resolvedMode: record.resolvedMode,
    policySource: record.policySource,
    risks:
      record.risks && record.risks.length > 0
        ? [...record.risks]
        : record.risk
          ? [record.risk]
          : [],
    risk: record.risk,
    sanitizedPayload,
    snapshotJson: record.snapshotJson,
    fingerprint: record.fingerprint,
    status: record.status,
    expiresAt: record.expiresAt,
    decision: record.decision,
    decidedByType: record.decidedByType,
    decidedById: record.decidedById,
    decisionNote: record.decisionNote,
    decidedAt: record.decidedAt,
    workflowId: record.workflowId,
    workflowName,
    runId: record.runId,
    runStatus,
    stepId: record.stepId,
    brandId,
    brandName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const listApprovalsWire = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(),
  actionKey: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
})

export const getApprovalRequestsOverview = createServerFn({ method: 'GET' })
  .validator((data?: { status?: string; actionKey?: string; limit?: number }) =>
    listApprovalsWire.parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<ApprovalsOverview> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { workspaceId: '', pendingCount: 0, requests: [] }
    }
    const db = getDb()
    const [pendingCount, rawRequests, brandsList] = await Promise.all([
      countPendingApprovals(db, workspace.id),
      listApprovalRequests(db, {
        workspaceId: workspace.id,
        ...(data.status ? { status: data.status } : {}),
        ...(data.actionKey ? { actionKey: data.actionKey } : {}),
        limit: data.limit ?? 100,
      }),
      listBrands(workspace.id),
    ])

    const brandsMap = new Map<string, string>()
    for (const b of brandsList) {
      brandsMap.set(b.id, b.name)
    }

    const requests = await Promise.all(
      rawRequests.map((req) => enrichApprovalRecord(db, req, brandsMap)),
    )

    return {
      workspaceId: workspace.id,
      pendingCount,
      requests,
    }
  })

const idWire = z.object({ id: z.uuid() })

export const getApprovalRequestFn = createServerFn({ method: 'GET' })
  .validator((d: z.infer<typeof idWire>) => idWire.parse(d))
  .handler(async ({ data }): Promise<ApprovalRequestItem | null> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) return null
    const db = getDb()
    const record = await getApprovalWithExpiryCheck(db, {
      workspaceId: workspace.id,
      id: data.id,
    })
    if (!record) return null

    const brandsList = await listBrands(workspace.id)
    const brandsMap = new Map<string, string>()
    for (const b of brandsList) {
      brandsMap.set(b.id, b.name)
    }

    return enrichApprovalRecord(db, record, brandsMap)
  })

const decideApprovalWire = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  note: z.string().trim().max(1000).nullable().optional(),
})

export const decideApprovalFn = createServerFn({ method: 'POST' })
  .validator((d: z.infer<typeof decideApprovalWire>) => decideApprovalWire.parse(d))
  .handler(async ({ data }): Promise<DecideApprovalResult> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace found')
    const db = getDb()
    const record = await decideApprovalRequest(db, {
      workspaceId: workspace.id,
      requestId: data.requestId,
      decision: data.decision,
      actor: {
        actorType: 'user',
        actorId: null,
      },
      ...(data.note !== undefined ? { note: data.note } : {}),
    })

    let resumeResult: { ok: boolean; message?: string } | null = null
    if (record.runId) {
      try {
        const { deps } = resolveAiRuntime()
        const res = await resumeWorkflowAfterApproval(db, record.id, { ai: deps })
        resumeResult = res
      } catch (err) {
        console.warn('Failed to auto-resume workflow after approval decision:', err)
        resumeResult = {
          ok: false,
          message: err instanceof Error ? err.message : 'Unknown resume error',
        }
      }
    }

    return { record, resumeResult }
  })

const createDevApprovalWire = z.object({
  actionKey: z.enum(ACTION_KEYS),
  origin: z.enum(['user', 'chief', 'agent', 'workflow', 'tool', 'system']).default('agent'),
  summary: z.string().trim().max(200).optional(),
  brandId: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(86400 * 30)
    .optional(),
})

export const createDevApprovalRequestFn = createServerFn({ method: 'POST' })
  .validator((d: z.infer<typeof createDevApprovalWire>) => createDevApprovalWire.parse(d))
  .handler(async ({ data }) => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) throw new Error('No workspace found')
    const db = getDb()

    const expiresAt = data.expiresInSeconds
      ? new Date(Date.now() + data.expiresInSeconds * 1000).toISOString()
      : null

    return createApprovalRequest(db, {
      workspaceId: workspace.id,
      actionKey: data.actionKey,
      origin: data.origin,
      payload: data.payload,
      expiresAt,
      ...(data.brandId !== undefined ? { brandId: data.brandId } : {}),
      ...(data.summary ? { summary: data.summary } : {}),
    })
  })
