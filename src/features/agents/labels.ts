import type { AgentExecutionType } from '~/types/domain'

/**
 * Normal-user labels for agent registry concepts. Technical names
 * (execution_type, model strategy, capability keys) never reach the UI.
 */

export const EXECUTION_TYPE_LABEL: Record<AgentExecutionType, string> = {
  direct_model: 'Direct AI Model',
  external_agent: 'External Agent',
  router: 'Smart Router',
}

export const STRATEGY_LABEL: Record<string, string> = {
  default: 'Default',
  fast: 'Fast',
  reasoning: 'Reasoning',
  cheap: 'Budget',
  vision: 'Vision',
}

export const CAPABILITY_LABEL: Record<string, string> = {
  read_context: 'Read workspace context',
  read_memory: 'Read memory',
  read_research: 'Read research',
  read_analytics: 'Read analytics',
  create_draft: 'Create drafts',
  propose_memory: 'Propose memory',
  request_workflow: 'Request workflows',
  publish: 'Publish (not available yet)',
  modify_account: 'Modify accounts',
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  disabled: 'Disabled',
  archived: 'Archived',
}
