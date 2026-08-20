import type { ActionKey } from '../policy/types.ts'
import type { ToolDefinition } from '../tools/types.ts'

/**
 * Resolves a platform-neutral ActionKey for a workflow tool step.
 *
 * Deterministic mapping rules:
 * - Direct tool mappings:
 *   - 'platform.publish' -> 'content.publish'
 *   - 'workflow.run' -> 'workflow.run'
 *   - 'image.generate' -> 'external.write'
 * - Risk-based derivations:
 *   - Destructive risk -> 'destructive.delete'
 *   - Write/External risk -> 'external.write' (or 'content.publish' for publishing)
 *   - Read risk -> 'workspace.read'
 * - Default safe fallback: 'workspace.read'
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
    if (
      risks.includes('write') ||
      risks.includes('external') ||
      definition.approval === 'required'
    ) {
      return 'external.write'
    }
    if (risks.includes('read')) {
      return 'workspace.read'
    }
  }

  return 'workspace.read'
}
