import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { z } from 'zod'

import { ACTIVE_BRAND_COOKIE } from '~/features/workspace/server'
import { buildContext, type ContextPackage, toContextErrorPayload } from '~/server/context'
import { getDb } from '~/server/db/client'
import { listRecentEvents } from '~/server/db/event'
import { getDefaultWorkspace } from '~/server/db/workspace'

/**
 * Server functions for the development-only Context Inspector
 * (/dev-context). Everything here is guarded by import.meta.env.DEV and
 * the route renders NotFound in production builds. Wire schemas are local
 * (never derived from repository schemas) so the client bundle can strip
 * every server import.
 */

export interface DevContextOptions {
  workspaceId: string | null
  brands: { id: string; name: string }[]
  products: { id: string; name: string }[]
  accounts: { id: string; label: string }[]
  conversations: { id: string; label: string }[]
}

interface OptionRows {
  brands: { id: string; name: string }[]
  products: { id: string; name: string }[]
  accounts: { id: string; label: string }[]
  conversations: { id: string; label: string }[]
}

async function loadOptions(db: ReturnType<typeof getDb>, workspaceId: string): Promise<OptionRows> {
  const [brands, products, accounts, conversations] = await Promise.all([
    db
      .prepare(
        `SELECT id, name FROM brand WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
      )
      .bind(workspaceId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT id, name FROM product WHERE deleted_at IS NULL AND status != 'archived'
         AND brand_id IN (SELECT id FROM brand WHERE workspace_id = ?) ORDER BY name ASC`,
      )
      .bind(workspaceId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT id, COALESCE(display_name, handle) AS label FROM account
         WHERE workspace_id = ? AND deleted_at IS NULL AND status != 'archived' ORDER BY label ASC`,
      )
      .bind(workspaceId)
      .all<{ id: string; label: string }>(),
    db
      .prepare(
        `SELECT id, COALESCE(title, 'Untitled') AS label FROM conversation
         WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`,
      )
      .bind(workspaceId)
      .all<{ id: string; label: string }>(),
  ])
  return {
    brands: brands.results,
    products: products.results,
    accounts: accounts.results,
    conversations: conversations.results,
  }
}

export const getDevContextOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DevContextOptions> => {
    if (!import.meta.env.DEV) {
      throw new Error('Not available.')
    }
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { workspaceId: null, brands: [], products: [], accounts: [], conversations: [] }
    }
    const options = await loadOptions(getDb(), workspace.id)
    return { workspaceId: workspace.id, ...options }
  },
)

const inspectWire = z.object({
  brandId: z.uuid().optional(),
  productId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  useUiBrand: z.boolean().default(false),
  taskText: z.string().trim().max(500).optional(),
})

export type DevContextResult =
  | { ok: true; package: ContextPackage }
  | { ok: false; error: { code: string; message: string } }

/**
 * Build a context package for inspection. The UI selection comes from the
 * real active-brand cookie when `useUiBrand` is set, so precedence
 * (explicit > conversation > ui > workspace) is exercised for real.
 */
export const getDevContextPackage = createServerFn({ method: 'POST' })
  .validator(inspectWire)
  .handler(async ({ data }): Promise<DevContextResult> => {
    if (!import.meta.env.DEV) {
      throw new Error('Not available.')
    }
    try {
      const pkg = await buildContext(getDb(), {
        ...(data.brandId ? { brandId: data.brandId } : {}),
        ...(data.productId ? { productId: data.productId } : {}),
        ...(data.accountId ? { accountId: data.accountId } : {}),
        ...(data.conversationId ? { conversationId: data.conversationId } : {}),
        ...(data.useUiBrand
          ? { uiSelection: { brandId: getCookie(ACTIVE_BRAND_COOKIE) ?? null } }
          : {}),
        ...(data.taskText ? { task: { text: data.taskText } } : {}),
      })
      return { ok: true, package: pkg }
    } catch (error) {
      return { ok: false, error: toContextErrorPayload(error) }
    }
  })

/** One parsed AI execution event for the dev inspector. Secrets-free. */
export interface DevAiExecution {
  id: string
  eventType: string
  occurredAt: string
  executionId: string | null
  agentVersionId: string | null
  provider: string | null
  model: string | null
  latencyMs: number | null
  attempts: number | null
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  } | null
  scopeSource: string | null
  errorCode: string | null
}

interface ExecutionPayloadFields {
  executionId?: unknown
  agentVersionId?: unknown
  provider?: unknown
  model?: unknown
  latencyMs?: unknown
  attempts?: unknown
  usage?: DevAiExecution['usage']
  scopeSource?: unknown
  code?: unknown
}

function parseExecutionPayload(payload: string | null): ExecutionPayloadFields {
  if (!payload) return {}
  try {
    const parsed = JSON.parse(payload)
    return typeof parsed === 'object' && parsed !== null ? (parsed as ExecutionPayloadFields) : {}
  } catch {
    return {}
  }
}

/**
 * Recent ai.execution.* events (started/completed/failed). Development-only
 * execution inspector: traceability without touching production UI.
 */
export const getDevAiExecutions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DevAiExecution[]> => {
    if (!import.meta.env.DEV) {
      throw new Error('Not available.')
    }
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return []
    }
    const rows = await listRecentEvents(getDb(), workspace.id, 'ai.execution.', 20)
    return rows.map((row) => {
      const payload = parseExecutionPayload(row.payload)
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      const num = (v: unknown) => (typeof v === 'number' ? v : null)
      return {
        id: row.id,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        executionId: str(payload.executionId),
        agentVersionId: str(payload.agentVersionId),
        provider: str(payload.provider),
        model: str(payload.model),
        latencyMs: num(payload.latencyMs),
        attempts: num(payload.attempts),
        usage: payload.usage ?? null,
        scopeSource: str(payload.scopeSource),
        errorCode: str(payload.code),
      }
    })
  },
)

/** One parsed tool execution event for the dev inspector. Secrets-free. */
export interface DevToolExecution {
  id: string
  eventType: string
  occurredAt: string
  executionId: string | null
  toolKey: string | null
  agentVersionId: string | null
  category: string | null
  risk: string[]
  requiredCapability: string | null
  durationMs: number | null
  errorCode: string | null
  argsSummary: Record<string, string | number | boolean | null>
}

interface ToolPayloadFields {
  executionId?: unknown
  toolKey?: unknown
  agentVersionId?: unknown
  category?: unknown
  risk?: unknown
  requiredCapability?: unknown
  durationMs?: unknown
  code?: unknown
  argsSummary?: unknown
}

function parseToolPayload(payload: string | null): ToolPayloadFields {
  if (!payload) return {}
  try {
    const parsed = JSON.parse(payload)
    return typeof parsed === 'object' && parsed !== null ? (parsed as ToolPayloadFields) : {}
  } catch {
    return {}
  }
}

/**
 * Recent tool.execution.* events (completed/failed). Development-only tool
 * trace: capability checks, durations and safe argument summaries. Never
 * includes secrets, raw external payloads or provider credentials.
 */
export const getDevToolExecutions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DevToolExecution[]> => {
    if (!import.meta.env.DEV) {
      throw new Error('Not available.')
    }
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return []
    }
    const rows = await listRecentEvents(getDb(), workspace.id, 'tool.execution.', 20)
    return rows.map((row) => {
      const payload = parseToolPayload(row.payload)
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      const num = (v: unknown) => (typeof v === 'number' ? v : null)
      return {
        id: row.id,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        executionId: str(payload.executionId),
        toolKey: str(payload.toolKey),
        agentVersionId: str(payload.agentVersionId),
        category: str(payload.category),
        risk: Array.isArray(payload.risk)
          ? payload.risk.filter((v): v is string => typeof v === 'string')
          : [],
        requiredCapability: str(payload.requiredCapability),
        durationMs: num(payload.durationMs),
        errorCode: str(payload.code),
        argsSummary:
          payload.argsSummary !== null &&
          typeof payload.argsSummary === 'object' &&
          !Array.isArray(payload.argsSummary)
            ? (payload.argsSummary as Record<string, string | number | boolean | null>)
            : {},
      }
    })
  },
)
