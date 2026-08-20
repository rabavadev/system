import type { ToolRisk } from '../tools/types.ts'
import { ACTION_DEFINITIONS, type ActionKey, type PolicyMode } from './types.ts'

/**
 * Returns the safe system default policy mode for a registered action key.
 */
export function getSystemDefaultMode(action: ActionKey): PolicyMode {
  const def = ACTION_DEFINITIONS[action]
  return def ? def.defaultMode : 'review'
}

/**
 * Derives a policy mode from STEP 9 Tool risk classifications.
 * Reuses the existing risk model without creating a second unrelated system.
 *
 * Rules:
 * - destructive / sensitive -> 'blocked'
 * - write / external -> 'review'
 * - read -> 'auto'
 */
export function deriveModeFromRisk(risk: readonly ToolRisk[] | ToolRisk | undefined): PolicyMode {
  if (!risk) return 'review'
  const risks = Array.isArray(risk) ? risk : [risk]

  if (risks.includes('destructive') || risks.includes('sensitive')) {
    return 'blocked'
  }
  if (risks.includes('write') || risks.includes('external')) {
    return 'review'
  }
  if (risks.includes('read')) {
    return 'auto'
  }
  return 'review'
}
