import { getApprovalPolicy } from '../db/policy.ts'
import type { SqlDatabase } from '../db/sql.ts'
import { deriveModeFromRisk, getSystemDefaultMode } from './defaults.ts'
import { checkHardSecurityInvariants } from './security.ts'
import {
  ACTION_KEYS,
  type ActionKey,
  type PolicyMode,
  type PolicyResolutionRequest,
  type PolicyResolutionResult,
  type PolicySource,
  type PolicyTrace,
  type PolicyTraceStep,
} from './types.ts'

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyValidationError'
  }
}

/**
 * Central server-side Approval Policy resolver.
 *
 * Evaluates: "What should happen when this kind of action is requested?"
 *
 * Precedence:
 * 1. Hard security invariants (NEVER overridable)
 * 2. Brand override (if brandId is provided and override exists)
 * 3. Workspace policy (if workspace policy exists)
 * 4. Risk fallback (if tool risk is provided)
 * 5. Safe system default
 *
 * Guaranteed to be platform-neutral, deterministic, and secret-free.
 */
export async function resolveApprovalPolicy(
  db: SqlDatabase,
  request: PolicyResolutionRequest,
): Promise<PolicyResolutionResult> {
  const { action, workspaceId, brandId = null, origin = 'system', risk, target: _target } = request

  // 0. Validate action key
  if (!ACTION_KEYS.includes(action as ActionKey)) {
    throw new PolicyValidationError(`Unsupported action key: "${action}"`)
  }
  const validAction = action as ActionKey

  const steps: PolicyTraceStep[] = []

  const buildResult = (
    mode: PolicyMode,
    source: PolicySource,
    reason: string,
    hasOverride: boolean,
  ): PolicyResolutionResult => {
    const trace: PolicyTrace = {
      action: validAction,
      origin,
      workspaceId,
      brandId: brandId ?? null,
      steps,
      resolvedMode: mode,
      source,
      reason,
    }
    return {
      action: validAction,
      mode,
      source,
      reason,
      hasOverride,
      origin,
      trace,
    }
  }

  // 1. Hard security invariants (cannot be overridden by any policy)
  const securityCheck = checkHardSecurityInvariants(request)
  if (securityCheck.blocked) {
    const reason = securityCheck.reason ?? 'Hard security block'
    steps.push({
      step: 'hard_security',
      matched: true,
      mode: 'blocked',
      source: 'hard_security',
      detail: reason,
    })
    return buildResult('blocked', 'hard_security', reason, false)
  }
  steps.push({
    step: 'hard_security',
    matched: false,
    detail: 'Hard security invariants passed',
  })

  // 2. Brand override
  if (brandId) {
    const brandPolicy = await getApprovalPolicy(db, {
      workspaceId,
      scopeType: 'brand',
      scopeId: brandId,
      actionKey: validAction,
    })
    if (brandPolicy) {
      steps.push({
        step: 'brand_override',
        matched: true,
        mode: brandPolicy.mode,
        source: 'brand_override',
        detail: `Brand override configured: ${brandPolicy.mode}`,
      })
      return buildResult(brandPolicy.mode, 'brand_override', 'Brand override', true)
    }
    steps.push({
      step: 'brand_override',
      matched: false,
      detail: `No brand override found for brand ${brandId}`,
    })
  }

  // 3. Workspace policy
  const workspacePolicy = await getApprovalPolicy(db, {
    workspaceId,
    scopeType: 'workspace',
    scopeId: workspaceId,
    actionKey: validAction,
  })
  if (workspacePolicy) {
    steps.push({
      step: 'workspace_policy',
      matched: true,
      mode: workspacePolicy.mode,
      source: 'workspace_policy',
      detail: `Workspace policy configured: ${workspacePolicy.mode}`,
    })
    return buildResult(workspacePolicy.mode, 'workspace_policy', 'Workspace policy', false)
  }
  steps.push({
    step: 'workspace_policy',
    matched: false,
    detail: 'No workspace policy found',
  })

  // 4. Risk fallback (if risk metadata is provided)
  if (risk) {
    const derivedMode = deriveModeFromRisk(risk)
    const riskLabel = Array.isArray(risk) ? risk.join(', ') : risk
    steps.push({
      step: 'risk_fallback',
      matched: true,
      mode: derivedMode,
      source: 'risk_fallback',
      detail: `Derived from risk [${riskLabel}]: ${derivedMode}`,
    })
    return buildResult(derivedMode, 'risk_fallback', `Derived from risk [${riskLabel}]`, false)
  }
  steps.push({
    step: 'risk_fallback',
    matched: false,
    detail: 'No risk metadata provided',
  })

  // 5. Safe system default
  const defaultMode = getSystemDefaultMode(validAction)
  steps.push({
    step: 'system_default',
    matched: true,
    mode: defaultMode,
    source: 'system_default',
    detail: `Safe system default: ${defaultMode}`,
  })
  return buildResult(defaultMode, 'system_default', 'Safe system default', false)
}
