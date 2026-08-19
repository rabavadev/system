import { z } from 'zod'

import type { ModelStrategy } from '../ai/types.ts'

/**
 * Agent Version configuration: the ONE shape allowed inside
 * agent_version.config (JSON). Identity (name, purpose, origin) lives on the
 * agent shell; everything that changes how an agent RUNS is versioned here,
 * so editing any of it creates version N+1 and history is never rewritten.
 *
 * Capabilities are DECLARATIVE intent (what the agent is meant to be allowed
 * to do once the Tool Registry exists). Declaring 'publish' grants nothing:
 * there is no enforcement/execution path for tools yet.
 *
 * Security: this schema is the boundary that keeps secrets out of D1. It
 * rejects secret-looking keys and values; external agents reference a
 * credential by NAME only (a future vault/Workers-secret pointer).
 */

export const AGENT_CAPABILITIES = [
  'read_context',
  'read_memory',
  'read_research',
  'read_analytics',
  'create_draft',
  'propose_memory',
  'request_workflow',
  'publish',
  'modify_account',
] as const
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number]

export const MODEL_STRATEGIES = ['default', 'fast', 'reasoning', 'cheap', 'vision'] as const

export const MAX_AGENT_INSTRUCTION_CHARS = 6000

/** Credential references are vault/secret NAMES, never values. */
const credentialRef = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Credential references look like MY_SECRET_NAME.')
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'External endpoints must be https URLs.',
  })

const externalConfig = z
  .object({
    /** Where the external agent lives. Metadata only — never called yet. */
    endpoint: httpsUrl.optional(),
    /** Provider-side agent identifier (e.g. an assistant id). */
    agentRef: z.string().trim().min(1).max(120).optional(),
    /** Name of a secret held outside D1. Never the secret itself. */
    credentialRef: credentialRef.optional(),
  })
  .strict()

const routerConfig = z
  .object({
    /** Strategies a future router may choose between. Declarative only. */
    allowedStrategies: z.array(z.enum(MODEL_STRATEGIES)).min(1).max(5),
  })
  .strict()

export const agentVersionConfigSchema = z
  .object({
    instructions: z
      .string()
      .trim()
      .min(1, 'Instructions are required.')
      .max(
        MAX_AGENT_INSTRUCTION_CHARS,
        `Keep instructions under ${MAX_AGENT_INSTRUCTION_CHARS} characters.`,
      ),
    model: z
      .object({ strategy: z.enum(MODEL_STRATEGIES) })
      .default({ strategy: 'default' as ModelStrategy }),
    generation: z
      .object({
        maxTokens: z.number().int().min(64).max(4096),
        temperature: z.number().min(0).max(2),
      })
      .default({ maxTokens: 1024, temperature: 0.4 }),
    capabilities: z
      .array(z.enum(AGENT_CAPABILITIES))
      .max(AGENT_CAPABILITIES.length)
      .default(['read_context' as AgentCapability]),
    external: externalConfig.optional(),
    router: routerConfig.optional(),
    /**
     * Who wrote this version: 'system' (shipped built-in, may be rotated by
     * a future deploy) or 'user' (user edit, NEVER silently reverted).
     * Set server-side; the client cannot supply it.
     */
    source: z.enum(['system', 'user']).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const problem of findSecretLikeContent(config)) {
      ctx.addIssue({ code: 'custom', message: problem })
    }
  })
export type AgentVersionConfig = z.infer<typeof agentVersionConfigSchema>
export type AgentVersionConfigInput = z.input<typeof agentVersionConfigSchema>

const FORBIDDEN_KEY = /(secret|token|api[-_]?key|password|authorization|private[-_]?key)/i
const FORBIDDEN_VALUE = /^(sk-|xox[baprs]-|Bearer\s+|-----BEGIN )/i

/** Keys that match FORBIDDEN_KEY by name but are legitimate config. */
const ALLOWED_KEYS = new Set(['credentialRef', 'maxTokens'])

/**
 * Recursive guard against secrets smuggled into agent config. credentialRef
 * is the one allowed "credential-ish" key and it holds a NAME, not a value.
 */
function findSecretLikeContent(value: unknown, path: string[] = []): string[] {
  const problems: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) problems.push(...findSecretLikeContent(item, path))
    return problems
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(key) && FORBIDDEN_KEY.test(key)) {
        problems.push(`'${[...path, key].join('.')}' looks like a secret field.`)
      }
      problems.push(...findSecretLikeContent(nested, [...path, key]))
    }
    return problems
  }
  if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
    problems.push(`'${path.join('.') || 'value'}' looks like a secret value.`)
  }
  return problems
}

/** Parse a stored config row. Returns null when the JSON/shape is invalid. */
export function parseAgentVersionConfig(configJson: string): AgentVersionConfig | null {
  try {
    const parsed = agentVersionConfigSchema.safeParse(JSON.parse(configJson))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
