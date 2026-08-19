import { createFileRoute } from '@tanstack/react-router'

import { ApprovalsPage } from '~/features/approvals/approvals-page'

export const Route = createFileRoute('/approvals')({
  component: ApprovalsPage,
})
