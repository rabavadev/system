import { z } from 'zod'

import type { ToolDefinition } from './types.ts'

/**
 * Built-in tool definitions: the ONE authoritative registry.
 *
 * Why not D1? Tools are code: their input/output contracts, risk and
 * capability requirements must be reviewed and shipped with the app, and
 * there is no user-configured tool data yet that would justify a table.
 * The registry is still a single typed map (not scattered constants), and
 * future external/custom tools can layer persistence behind this surface
 * without changing executeTool callers.
 *
 * Definitions carry NO adapter implementation. Available internal tools are
 * wired in adapters/index.ts; external tools are declared here with an
 * honest status and return controlled results until a real adapter exists.
 */

const idArg = z.uuid()
const limitArg = z.number().int().min(1).max(20).default(10)

const productOutput = z.object({
  id: z.uuid(),
  brandId: z.uuid(),
  nicheId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  status: z.enum(['draft', 'active', 'archived']),
})

const accountOutput = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(['active', 'paused', 'disconnected', 'archived']),
  platform: z.object({ id: z.uuid(), name: z.string() }),
  connectionStatus: z.enum(['connected', 'expired', 'error', 'disconnected']).nullable(),
})

const contextSummaryOutput = z.object({
  generatedAt: z.string(),
  workspace: z.object({ id: z.uuid(), name: z.string(), slug: z.string().nullable() }),
  activeScope: z.object({ type: z.string(), id: z.uuid().nullable() }),
  scopeSource: z.enum(['explicit', 'conversation', 'ui', 'workspace']),
  brand: z
    .object({ id: z.uuid(), name: z.string(), description: z.string().nullable() })
    .nullable(),
  product: productOutput.nullable(),
  account: accountOutput.nullable(),
  counts: z.object({
    messages: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    research: z.number().int().nonnegative(),
    goals: z.number().int().nonnegative(),
  }),
})

const memoryOutput = z.object({
  id: z.uuid(),
  memoryClass: z.enum([
    'permanent_fact',
    'verified_learning',
    'proposed_learning',
    'temporary_context',
  ]),
  authority: z.enum(['fact', 'trusted', 'hypothesis', 'ephemeral']),
  content: z.string(),
  scopeType: z.enum(['workspace', 'brand', 'niche', 'account', 'platform', 'product', 'campaign']),
  scopeId: z.uuid().nullable(),
  confidence: z.number().nullable(),
  sourceType: z.enum(['user', 'agent', 'research', 'observation', 'import', 'manual']),
  freshness: z.enum(['current', 'aging', 'stale', 'expired']),
  lastVerifiedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
})

const researchOutput = z.object({
  id: z.uuid(),
  subject: z.string(),
  findings: z.string().nullable(),
  status: z.enum(['draft', 'in_progress', 'completed', 'stale', 'archived']),
  confidence: z.number().nullable(),
  scopeType: z
    .enum(['workspace', 'brand', 'niche', 'account', 'platform', 'product', 'campaign'])
    .nullable(),
  scopeId: z.uuid().nullable(),
  freshness: z.enum(['current', 'aging', 'stale', 'expired']),
  lastVerifiedAt: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
})

const emptyObject = z.object({}).strict()
const analyticsOutput = z.object({
  metrics: z.array(
    z.object({
      key: z.string(),
      value: z.number(),
      observedAt: z.string(),
      subjectType: z.string(),
      subjectId: z.uuid(),
    }),
  ),
})

const webSearchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({ title: z.string(), url: z.string().url(), snippet: z.string().nullable() }),
  ),
})

const fileListOutput = z.object({
  files: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.enum(['image', 'video', 'audio', 'document', 'other']),
      mimeType: z.string().nullable(),
      sizeBytes: z.number().int().nonnegative().nullable(),
      createdAt: z.string(),
    }),
  ),
})

const fileReadOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  mimeType: z.string().nullable(),
  contentText: z.string().nullable(),
})

const imageOutput = z.object({ assetId: z.uuid(), url: z.string().url().nullable() })

const platformPostsOutput = z.object({
  posts: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(['draft', 'scheduled', 'publishing', 'published', 'failed', 'removed']),
      url: z.string().nullable(),
      publishedAt: z.string().nullable(),
    }),
  ),
})

const publishOutput = z.object({
  postId: z.uuid(),
  externalId: z.string().nullable(),
  url: z.string().nullable(),
})

function stringField(input: unknown, key: string): string | null {
  if (input === null || typeof input !== 'object') {
    return null
  }
  const value = Reflect.get(input, key) as unknown
  return typeof value === 'string' ? value : null
}

const summarizeId =
  (field: string) =>
  (input: unknown): Record<string, string | number | boolean | null> => ({
    [field]: stringField(input, field),
  })

export const TOOL_DEFINITIONS = [
  {
    key: 'workspace.get_current_context',
    name: 'Read current context',
    description: 'Reads a safe summary of the current workspace scope through the Context Engine.',
    category: 'workspace',
    inputSchema: z.object({ includeCounts: z.boolean().default(true) }).strict(),
    outputSchema: contextSummaryOutput,
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'workspace.get_product',
    name: 'Read a product',
    description: 'Reads one active product in this workspace.',
    category: 'workspace',
    inputSchema: z.object({ productId: idArg }).strict(),
    outputSchema: productOutput,
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: summarizeId('productId'),
  },
  {
    key: 'workspace.list_products',
    name: 'List products',
    description: 'Lists active products in this workspace, optionally for one brand.',
    category: 'workspace',
    inputSchema: z.object({ brandId: idArg.optional(), limit: limitArg }).strict(),
    outputSchema: z.object({ products: z.array(productOutput) }),
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: (input) => ({ brandId: stringField(input, 'brandId') }),
  },
  {
    key: 'workspace.get_account',
    name: 'Read an account',
    description: 'Reads one active connected-account record with safe platform metadata.',
    category: 'workspace',
    inputSchema: z.object({ accountId: idArg }).strict(),
    outputSchema: accountOutput,
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: summarizeId('accountId'),
  },
  {
    key: 'workspace.list_accounts',
    name: 'List accounts',
    description: 'Lists active accounts in this workspace with safe platform metadata.',
    category: 'workspace',
    inputSchema: z.object({ limit: limitArg }).strict(),
    outputSchema: z.object({ accounts: z.array(accountOutput) }),
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'memory.list_relevant',
    name: 'Read relevant memory',
    description: 'Reads memory the Context Engine considers relevant and safe right now.',
    category: 'memory',
    inputSchema: z.object({ limit: limitArg }).strict(),
    outputSchema: z.object({ memories: z.array(memoryOutput) }),
    requiredCapability: 'read_memory',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'research.list_relevant',
    name: 'Read stored research',
    description: 'Reads stored research with freshness. This is not live web research.',
    category: 'research',
    inputSchema: z.object({ limit: limitArg }).strict(),
    outputSchema: z.object({ research: z.array(researchOutput) }),
    requiredCapability: 'read_research',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'available',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'analytics.read',
    name: 'Read analytics',
    description: 'Will read ingested performance analytics once analytics sync exists.',
    category: 'analytics',
    inputSchema: emptyObject,
    outputSchema: analyticsOutput,
    requiredCapability: 'read_analytics',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'needs_setup',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'web.search',
    name: 'Web search',
    description: 'Will search the public web once a safe search provider is configured.',
    category: 'web',
    inputSchema: z.object({ query: z.string().trim().min(1).max(300), limit: limitArg }).strict(),
    outputSchema: webSearchOutput,
    requiredCapability: 'read_research',
    risk: ['read', 'external'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'external',
    version: 1,
    timeoutMs: 10_000,
    cost: 'metered',
    summarizeInput: () => ({ query: '[redacted]' }),
  },
  {
    key: 'files.list',
    name: 'List files',
    description: 'Will list file metadata once file storage is connected.',
    category: 'files',
    inputSchema: emptyObject,
    outputSchema: fileListOutput,
    requiredCapability: 'read_context',
    risk: ['read'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: () => ({}),
  },
  {
    key: 'files.read',
    name: 'Read a file',
    description: 'Will read file contents once file storage is connected.',
    category: 'files',
    inputSchema: z.object({ fileId: idArg }).strict(),
    outputSchema: fileReadOutput,
    requiredCapability: 'read_context',
    risk: ['read', 'sensitive'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'internal',
    version: 1,
    cost: 'none',
    summarizeInput: summarizeId('fileId'),
  },
  {
    key: 'image.generate',
    name: 'Generate image',
    description: 'Will generate images once a media provider is configured and approved.',
    category: 'media',
    inputSchema: z.object({ prompt: z.string().trim().min(1).max(1000) }).strict(),
    outputSchema: imageOutput,
    requiredCapability: 'create_draft',
    risk: ['write', 'external', 'sensitive'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'external',
    version: 1,
    timeoutMs: 30_000,
    cost: 'metered',
    approval: 'required',
    summarizeInput: () => ({ prompt: '[redacted]' }),
  },
  {
    key: 'platform.get_posts',
    name: 'Read platform posts',
    description: 'Will read posts from a connected platform once platform adapters exist.',
    category: 'platform',
    inputSchema: z.object({ accountId: idArg, limit: limitArg }).strict(),
    outputSchema: platformPostsOutput,
    requiredCapability: 'read_analytics',
    risk: ['read', 'external'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'external',
    version: 1,
    timeoutMs: 10_000,
    cost: 'metered',
    summarizeInput: summarizeId('accountId'),
  },
  {
    key: 'platform.get_analytics',
    name: 'Read platform analytics',
    description: 'Will read platform-native analytics once platform adapters exist.',
    category: 'platform',
    inputSchema: z.object({ accountId: idArg }).strict(),
    outputSchema: analyticsOutput,
    requiredCapability: 'read_analytics',
    risk: ['read', 'external'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'external',
    version: 1,
    timeoutMs: 10_000,
    cost: 'metered',
    summarizeInput: summarizeId('accountId'),
  },
  {
    key: 'platform.publish',
    name: 'Publish content',
    description: 'Will publish approved content through a platform adapter. Not available yet.',
    category: 'platform',
    inputSchema: z
      .object({
        accountId: idArg,
        contentVariantId: idArg,
        idempotencyKey: z.string().max(120).optional(),
      })
      .strict(),
    outputSchema: publishOutput,
    requiredCapability: 'publish',
    risk: ['write', 'external'] as const,
    executionMode: 'sync',
    status: 'unavailable',
    origin: 'external',
    version: 1,
    timeoutMs: 15_000,
    cost: 'metered',
    approval: 'required',
    summarizeInput: (input) => ({
      accountId: stringField(input, 'accountId'),
      contentVariantId: stringField(input, 'contentVariantId'),
    }),
  },
] satisfies readonly ToolDefinition[]
