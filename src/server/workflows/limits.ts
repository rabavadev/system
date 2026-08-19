/**
 * Centralized workflow limits. EVERY bound lives here — definitions,
 * bindings, run execution, loop bounds, persistence sizes. No component
 * invents its own numbers.
 *
 * Run limits are frozen into the run plan at start (resolveRunLimits), so
 * a run is reproducible even if defaults change later.
 */

export const WORKFLOW_LIMITS = {
  /** Definition authoring */
  maxStepsPerDefinition: 25,
  maxDefinitionChars: 20_000,
  maxStepIdChars: 60,
  maxTaskChars: 2_000,
  maxBindingsPerStep: 12,
  maxInputsPerDefinition: 12,
  maxInputValueChars: 4_000,
  maxConditionBranches: 8,

  /** Run execution (defaults; a definition may only tighten them) */
  maxStepExecutionsPerRun: 50,
  maxVisitsPerStep: 5,
  maxAgentExecutionsPerRun: 20,
  maxToolExecutionsPerRun: 20,
  /** Wall-clock budget for one inline drive; checked between steps. */
  maxRunDurationMs: 5 * 60_000,

  /** Persistence safety */
  maxStepSnapshotChars: 20_000,
  maxRunOutputChars: 20_000,
} as const

export interface RunLimits {
  maxStepExecutions: number
  maxVisitsPerStep: number
  maxAgentExecutions: number
  maxToolExecutions: number
  maxRunDurationMs: number
}

/**
 * Definition-level limit overrides may only TIGHTEN the global bounds,
 * never exceed them. Resolved once at run start and frozen into the plan.
 */
export function resolveRunLimits(
  overrides?: Partial<Record<keyof RunLimits, number | undefined>> | null,
): RunLimits {
  const clamp = (value: number | undefined, max: number, fallback: number) =>
    value === undefined ? fallback : Math.max(1, Math.min(Math.floor(value), max))
  return {
    maxStepExecutions: clamp(
      overrides?.maxStepExecutions,
      WORKFLOW_LIMITS.maxStepExecutionsPerRun,
      WORKFLOW_LIMITS.maxStepExecutionsPerRun,
    ),
    maxVisitsPerStep: clamp(
      overrides?.maxVisitsPerStep,
      WORKFLOW_LIMITS.maxVisitsPerStep,
      WORKFLOW_LIMITS.maxVisitsPerStep,
    ),
    maxAgentExecutions: clamp(
      overrides?.maxAgentExecutions,
      WORKFLOW_LIMITS.maxAgentExecutionsPerRun,
      WORKFLOW_LIMITS.maxAgentExecutionsPerRun,
    ),
    maxToolExecutions: clamp(
      overrides?.maxToolExecutions,
      WORKFLOW_LIMITS.maxToolExecutionsPerRun,
      WORKFLOW_LIMITS.maxToolExecutionsPerRun,
    ),
    maxRunDurationMs: clamp(
      overrides?.maxRunDurationMs,
      WORKFLOW_LIMITS.maxRunDurationMs,
      WORKFLOW_LIMITS.maxRunDurationMs,
    ),
  }
}

/** Truncate a persisted JSON snapshot so a runaway output cannot bloat D1. */
export function boundedSnapshot(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value ?? null)
  if (json.length <= maxChars) return json
  return JSON.stringify({
    truncated: true,
    originalChars: json.length,
    preview: json.slice(0, maxChars),
  })
}
