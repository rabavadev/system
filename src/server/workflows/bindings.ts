import type { BindingSource, JsonValue, StepBinding } from './definition.ts'

/**
 * Safe value resolution. Bindings are DATA ({ source, path }) — never
 * expressions, never evaluated code. Paths are dotted keys walked over
 * plain JSON objects; anything missing resolves to `undefined`, which the
 * caller treats as "no value" (never an exception mid-run).
 */

export interface BindingScope {
  /** Validated workflow inputs from run start. */
  workflowInputs: Record<string, JsonValue>
  /** Latest succeeded output per step id. */
  stepOutputs: Record<string, JsonValue>
  /** Safe run metadata. */
  run: { runId: string; workflowId: string; workflowVersionId: string }
}

/** Walk a dotted path over plain JSON. No prototype keys, no evaluation. */
export function getPathValue(value: unknown, path: string): JsonValue | undefined {
  if (path.includes('__proto__') || path.includes('constructor')) return undefined
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === undefined) return undefined
  if (
    current === null ||
    typeof current === 'string' ||
    typeof current === 'number' ||
    typeof current === 'boolean' ||
    Array.isArray(current)
  ) {
    return current as JsonValue
  }
  return current as JsonValue
}

export function resolveBindingSource(
  source: BindingSource,
  scope: BindingScope,
): JsonValue | undefined {
  switch (source.source) {
    case 'workflow_input':
      return getPathValue(scope.workflowInputs, source.path)
    case 'step_output': {
      const output = scope.stepOutputs[source.stepId]
      if (output === undefined) return undefined
      return getPathValue(output, source.path)
    }
    case 'literal':
      return source.value
    case 'run':
      return scope.run[source.path]
  }
}

/** Resolve a step's declared inputs into one plain object. */
export function resolveBindings(
  bindings: readonly StepBinding[],
  scope: BindingScope,
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {}
  for (const binding of bindings) {
    const value = resolveBindingSource(binding.value, scope)
    if (value !== undefined) {
      resolved[binding.key] = value
    }
  }
  return resolved
}
