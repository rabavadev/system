import { QueryClient } from '@tanstack/react-query'

/**
 * Central TanStack Query client factory.
 * Defaults are conservative; feature-specific options belong in feature hooks.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  })
}
