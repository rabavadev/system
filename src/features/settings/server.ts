import { createServerFn } from '@tanstack/react-start'

import { resolveAiRuntime } from '~/server/ai/runtime'

/**
 * Minimal AI/Chief status for the settings screen. Reports configuration
 * state only — never secrets, never raw env values beyond the provider key.
 */
export interface ChiefStatus {
  configured: boolean
  provider: string
  detail: string
}

export const getChiefStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ChiefStatus> => {
    return resolveAiRuntime().status
  },
)
