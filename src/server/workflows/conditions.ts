import type { ConditionOperator, JsonValue } from './definition.ts'

/**
 * Deterministic condition evaluation. Conditions compare structured data
 * with a small fixed operator set. There is deliberately NO arbitrary
 * expression language and NO AI call just to branch a workflow.
 */

export interface ConditionEvaluation {
  left: JsonValue | undefined
  operator: ConditionOperator
  compareTo: JsonValue | undefined
  result: boolean
}

export function evaluateCondition(
  left: JsonValue | undefined,
  operator: ConditionOperator,
  compareTo: JsonValue | undefined,
): ConditionEvaluation {
  let result: boolean
  switch (operator) {
    case 'exists':
      result = left !== undefined && left !== null
      break
    case 'not_exists':
      result = left === undefined || left === null
      break
    case 'equals':
      result = jsonEquals(left, compareTo)
      break
    case 'not_equals':
      result = !jsonEquals(left, compareTo)
      break
    case 'greater_than':
      result = compareNumbers(left, compareTo, (a, b) => a > b)
      break
    case 'greater_or_equal':
      result = compareNumbers(left, compareTo, (a, b) => a >= b)
      break
    case 'less_than':
      result = compareNumbers(left, compareTo, (a, b) => a < b)
      break
    case 'less_or_equal':
      result = compareNumbers(left, compareTo, (a, b) => a <= b)
      break
  }
  return { left: left ?? null, operator, compareTo: compareTo ?? null, result }
}

function asNumber(value: JsonValue | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** Numeric comparisons only apply when both sides are numeric. */
function compareNumbers(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  compare: (a: number, b: number) => boolean,
): boolean {
  const a = asNumber(left)
  const b = asNumber(right)
  return a !== null && b !== null && compare(a, b)
}

/** Structural equality for JSON values (deterministic key order). */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return canonical(a) === canonical(b)
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
