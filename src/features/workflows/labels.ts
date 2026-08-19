/** Human labels for workflow concepts. The UI never shows raw enums. */

export const WORKFLOW_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  disabled: 'Disabled',
  archived: 'Archived',
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for approval',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const STEP_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
}

export const STEP_TYPE_LABEL: Record<string, string> = {
  agent: 'Agent step',
  tool: 'Tool step',
  condition: 'Decision',
  end: 'End',
}

export const OPERATOR_LABEL: Record<string, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  exists: 'has a value',
  not_exists: 'has no value',
  greater_than: 'is greater than',
  greater_or_equal: 'is at least',
  less_than: 'is less than',
  less_or_equal: 'is at most',
}

export function runStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'muted' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'running':
    case 'queued':
    case 'waiting':
      return 'warning'
    default:
      return 'muted'
  }
}
