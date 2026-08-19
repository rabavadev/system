import { createFileRoute } from '@tanstack/react-router'

import { ResearchPage } from '~/features/research/research-page'

export const Route = createFileRoute('/research')({
  component: ResearchPage,
})
