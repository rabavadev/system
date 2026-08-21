export {
  type BraveClientOptions,
  BraveSearchClient,
  createWebSearchAdapter,
  MockWebSearchClient,
  type MockWebSearchOptions,
  webSearchAdapter,
} from './adapters/web/index.ts'
export type {
  RawSearchResult,
  WebSearchOutput,
  WebSearchProviderClient,
  WebSearchResultItem,
} from './adapters/web/types.ts'
export { TOOL_DEFINITIONS } from './definitions.ts'
export type {
  ExecuteToolDeps,
  ExecuteToolInput,
  PrepareToolExecutionInput,
  ToolPreparationResult,
} from './executor.ts'
export { executeTool, getAvailableTools, prepareToolExecution } from './executor.ts'
export {
  filterToolsForCaller,
  getToolDefinition,
  listToolDefinitions,
  listToolDescriptors,
  toAIToolDefinition,
  toToolDescriptor,
  zodToJsonSchema,
} from './registry.ts'
export type {
  ToolAdapter,
  ToolCaller,
  ToolCategory,
  ToolDefinition,
  ToolDescriptor,
  ToolErrorCode,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolKey,
  ToolRisk,
  ToolStatus,
} from './types.ts'
export {
  TOOL_CATEGORIES,
  TOOL_ERROR_CODES,
  TOOL_KEYS,
  TOOL_RISKS,
  TOOL_STATUSES,
  ToolError,
} from './types.ts'
