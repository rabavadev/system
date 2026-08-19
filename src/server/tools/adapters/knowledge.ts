import { buildContext } from '../../context/index.ts'
import type { ToolAdapter } from '../types.ts'

/**
 * Memory/research read adapters. These do NOT query memory or research
 * tables directly: relevance, lifecycle exclusions (archived, superseded,
 * rejected, expired), authority mapping and freshness stay owned by the
 * Context Engine (STEP 5/STEP 7 remain authoritative).
 */

export const listRelevantMemoryAdapter: ToolAdapter = {
  key: 'memory.list_relevant',
  async run({ db, workspaceId, args, context }) {
    const { limit } = args as { limit: number }
    const pkg = await buildContext(db, {
      workspaceId,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.uiBrandId ? { uiSelection: { brandId: context.uiBrandId } } : {}),
      ...(context?.taskText ? { task: { text: context.taskText } } : {}),
    })
    return { memories: pkg.memories.slice(0, limit) }
  },
}

export const listRelevantResearchAdapter: ToolAdapter = {
  key: 'research.list_relevant',
  async run({ db, workspaceId, args, context }) {
    const { limit } = args as { limit: number }
    const pkg = await buildContext(db, {
      workspaceId,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.uiBrandId ? { uiSelection: { brandId: context.uiBrandId } } : {}),
      ...(context?.taskText ? { task: { text: context.taskText } } : {}),
    })
    return { research: pkg.research.slice(0, limit) }
  },
}
