import type { LucideIcon } from 'lucide-react'

import { PageHeader } from '~/components/layout/page-header'
import { EmptyState } from '~/components/ui/empty-state'

interface FeatureScreenProps {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  icon: LucideIcon
}

/**
 * Standard feature page frame: header plus a single empty state.
 * Features replace the empty state with real content as they are built.
 */
export function FeatureScreen({
  title,
  description,
  emptyTitle,
  emptyDescription,
  icon,
}: FeatureScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader title={title} description={description} />
      <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} />
    </div>
  )
}
