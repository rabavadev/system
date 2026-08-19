import { z } from 'zod'

/**
 * Client/server wire schemas for Memory. Deliberately free of server/db
 * imports so TanStack Start can tree-shake server code from the browser.
 * Trusted provenance is derived server-side from sourceMessageId; clients
 * cannot send sourceType, status, verification dates or supersession ids.
 */

export const memoryClassWire = z.enum([
  'permanent_fact',
  'verified_learning',
  'proposed_learning',
  'temporary_context',
])
export type MemoryClassWire = z.infer<typeof memoryClassWire>

export const confidenceLevelWire = z.enum(['low', 'medium', 'high'])
export type ConfidenceLevelWire = z.infer<typeof confidenceLevelWire>

export const memoryScopeTypeWire = z.enum([
  'workspace',
  'brand',
  'niche',
  'account',
  'platform',
  'product',
  'campaign',
])

const scopeWire = {
  scopeType: memoryScopeTypeWire.default('workspace'),
  scopeId: z.uuid().nullable().optional(),
  /** Optional consistency context; server validates it against real rows. */
  contextBrandId: z.uuid().nullable().optional(),
  contextNicheId: z.uuid().nullable().optional(),
  contextProductId: z.uuid().nullable().optional(),
}

function checkScope(
  data: { scopeType: string; scopeId?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.scopeType === 'workspace' && data.scopeId) {
    ctx.addIssue({ code: 'custom', message: 'Workspace memory applies to the whole workspace.' })
  }
  if (data.scopeType !== 'workspace' && !data.scopeId) {
    ctx.addIssue({ code: 'custom', message: 'Choose what this memory applies to.' })
  }
}

export const createMemoryWire = z
  .object({
    memoryClass: memoryClassWire,
    content: z.string().trim().min(1, 'Write the memory first.').max(4000),
    ...scopeWire,
    confidenceLevel: confidenceLevelWire.nullable().optional(),
    evidence: z.string().trim().max(2000).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: false }).nullable().optional(),
    /** Reviewed Chat message this memory came from. Provenance is derived server-side. */
    sourceMessageId: z.uuid().nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    checkScope(data, ctx)
    if (data.memoryClass === 'verified_learning') {
      if (!data.confidenceLevel) {
        ctx.addIssue({ code: 'custom', message: 'Choose a confidence level.' })
      }
      if (!data.evidence?.trim()) {
        ctx.addIssue({ code: 'custom', message: 'Add evidence before saving a verified learning.' })
      }
    }
    if (data.memoryClass === 'temporary_context' && data.confidenceLevel) {
      ctx.addIssue({ code: 'custom', message: 'Temporary context does not use confidence.' })
    }
  })
export type CreateMemoryWire = z.input<typeof createMemoryWire>

export const updateMemoryWire = z
  .object({
    id: z.uuid(),
    content: z.string().trim().min(1, 'Write the memory first.').max(4000),
    ...scopeWire,
    confidenceLevel: confidenceLevelWire.nullable().optional(),
    evidence: z.string().trim().max(2000).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: false }).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => checkScope(data, ctx))
export type UpdateMemoryWire = z.input<typeof updateMemoryWire>

export const verifyMemoryWire = z
  .object({
    id: z.uuid(),
    confidenceLevel: confidenceLevelWire,
    evidence: z.string().trim().min(1, 'Add evidence before verifying this.').max(2000),
  })
  .strict()
export type VerifyMemoryWire = z.input<typeof verifyMemoryWire>

export const memoryIdWire = z.object({ id: z.uuid() }).strict()

export const supersedeMemoryWire = z
  .object({
    id: z.uuid(),
    content: z.string().trim().min(1, 'Write the replacement first.').max(4000),
    ...scopeWire,
    confidenceLevel: confidenceLevelWire.nullable().optional(),
    evidence: z.string().trim().max(2000).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: false }).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => checkScope(data, ctx))
export type SupersedeMemoryWire = z.input<typeof supersedeMemoryWire>

export const memoryFiltersWire = z
  .object({
    memoryClass: memoryClassWire.optional(),
    status: z.enum(['active', 'superseded', 'archived', 'rejected']).optional(),
    freshness: z.enum(['current', 'expired']).optional(),
    brandId: z.uuid().optional(),
    nicheId: z.uuid().optional(),
    productId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    platformId: z.uuid().optional(),
    query: z.string().trim().max(200).optional(),
  })
  .strict()
export type MemoryFiltersWire = z.input<typeof memoryFiltersWire>
