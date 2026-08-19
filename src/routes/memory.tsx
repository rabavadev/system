import { createFileRoute } from '@tanstack/react-router'

import { MemoryPage } from '~/features/memory/memory-page'

export const Route = createFileRoute('/memory')({
  component: MemoryPage,
})
