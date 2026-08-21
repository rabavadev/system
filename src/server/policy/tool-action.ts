import type { ToolDefinition } from '../tools/types.ts'
import type { ActionKey } from './types.ts'

/**
 * Resolves a platform-neutral ActionKey for a tool execution (direct Agent or Workflow step).
 *
 * Conceptual precedence:
 * 1. Known direct mappings ('platform.publish', 'workflow.run', 'image.generate')
 * 2. Destructive risk -> 'destructive.delete'
 * 3. Platform write/publish -> 'content.publish'
 * 4. External write mutation -> 'external.write'
 * 5. External read (external without write) -> 'external.read'
 * 6. Plain internal read -> 'workspace.read'
 * 7. Safe fallback -> 'workspace.read'
 *
 * Note: Approval requirement ('approval: required') does NOT determine action semantics.
 */
export function resolveActionKeyForTool(
  toolKey: string,
  definition?: ToolDefinition | null,
): ActionKey {
  if (toolKey === 'platform.publish') {
    return 'content.publish'
  }
  if (toolKey === 'workflow.run') {
    return 'workflow.run'
  }
  if (toolKey === 'image.generate') {
    return 'external.write'
  }

  if (definition) {
    const risks = definition.risk ?? []
    if (risks.includes('destructive')) {
      return 'destructive.delete'
    }
    if (definition.category === 'platform' && risks.includes('write')) {
      return 'content.publish'
    }
    if (risks.includes('write') && risks.includes('external')) {
      return 'external.write'
    }
    if (risks.includes('write')) {
      return 'external.write'
    }
    if (risks.includes('external')) {
      return 'external.read'
    }
    if (risks.includes('read')) {
      return 'workspace.read'
    }
  }

  return 'workspace.read'
}
