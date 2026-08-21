import { z } from 'zod'
import type { AIToolDefinition } from '../ai/types.ts'
import { TOOL_DEFINITIONS } from './definitions.ts'
import type { ToolCaller, ToolDefinition, ToolDescriptor, ToolKey } from './types.ts'

/**
 * Tool Registry lookup and discovery. Definitions are built-in and typed
 * (see definitions.ts for why there is no D1 table yet). This module is
 * pure metadata: no env, no adapters, no provider schemas.
 */

const BY_KEY: ReadonlyMap<ToolKey, ToolDefinition> = new Map(
  TOOL_DEFINITIONS.map((definition) => [definition.key, definition]),
)

export function getToolDefinition(key: string): ToolDefinition | null {
  return BY_KEY.get(key as ToolKey) ?? null
}

export function listToolDefinitions(): readonly ToolDefinition[] {
  return TOOL_DEFINITIONS
}

/** Converts a server Zod schema to a safe, provider-neutral JSON Schema. */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', target: 'openApi3' }) as Record<string, unknown>
}

/** Provider-neutral model tool definition: includes safe JSON input schema, never server secrets or adapters. */
export function toAIToolDefinition(definition: ToolDefinition): AIToolDefinition {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    inputSchema: zodToJsonSchema(definition.inputSchema),
  }
}

/** Safe public descriptor: schemas and handlers never leave the server boundary. */
export function toToolDescriptor(definition: ToolDefinition): ToolDescriptor {
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    status: definition.status,
    risk: definition.risk,
    requiredCapability: definition.requiredCapability,
    origin: definition.origin,
    version: definition.version,
    cost: definition.cost,
  }
}

export function listToolDescriptors(): ToolDescriptor[] {
  return TOOL_DEFINITIONS.map(toToolDescriptor)
}

/**
 * Pure permission filter: an agent may DISCOVER a tool only when it is
 * active, declares the required capability, and the tool itself is enabled.
 * Availability/configuration is a separate layer checked at execution.
 */
export function filterToolsForCaller(
  caller: ToolCaller,
  definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS,
): ToolDescriptor[] {
  if (caller.agentStatus !== 'active') {
    return []
  }
  return definitions
    .filter(
      (definition) =>
        definition.status === 'available' &&
        caller.capabilities.includes(definition.requiredCapability),
    )
    .map(toToolDescriptor)
}
