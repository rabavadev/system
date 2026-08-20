import type { PolicyResolutionRequest } from './types.ts'

export interface HardSecurityCheckResult {
  blocked: boolean
  reason: string | null
}

/**
 * Checks non-overridable hard security invariants.
 *
 * Hard security rules sit above any user or brand policy.
 * "AUTO" policy must NEVER mean "ignore security."
 *
 * Hard security blocks:
 * 1. Secret exposure (credentials, tokens, secret_ref).
 * 2. Cross-workspace boundary bypass.
 * 3. Arbitrary code execution (eval, dynamic script loading).
 * 4. Security enforcement bypass.
 */
export function checkHardSecurityInvariants(
  request: PolicyResolutionRequest,
): HardSecurityCheckResult {
  const target = request.target

  if (target?.isSecret) {
    return {
      blocked: true,
      reason: 'Hard security block: access or exposure of secrets is strictly prohibited',
    }
  }

  if (target?.crossWorkspace) {
    return {
      blocked: true,
      reason: 'Hard security block: cross-workspace access violates tenant isolation',
    }
  }

  if (target?.arbitraryCode) {
    return {
      blocked: true,
      reason: 'Hard security block: arbitrary code execution is strictly prohibited',
    }
  }

  if (target?.executionBypass) {
    return {
      blocked: true,
      reason: 'Hard security block: security enforcement bypass is strictly prohibited',
    }
  }

  return {
    blocked: false,
    reason: null,
  }
}
