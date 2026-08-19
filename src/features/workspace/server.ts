import { createServerFn } from '@tanstack/react-start'

import { getDefaultWorkspace } from '~/server/db/workspace'

export interface WorkspaceSummary {
  name: string
}

/**
 * Server function: the only way client code reaches workspace data.
 * Returns null when the database is not migrated/seeded yet so the shell
 * can fall back to static labels instead of crashing.
 */
export const getWorkspaceSummary = createServerFn({ method: 'GET' }).handler(
  async (): Promise<WorkspaceSummary | null> => {
    try {
      const workspace = await getDefaultWorkspace()
      return workspace ? { name: workspace.name } : null
    } catch (error) {
      console.warn('workspace summary unavailable (is D1 migrated?):', error)
      return null
    }
  },
)
