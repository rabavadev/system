import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  /** The next useful action, when one exists. */
  action?: ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
        <Icon className="size-4.5" strokeWidth={1.75} />
      </div>
      <h2 className="text-sm font-medium text-zinc-900">{title}</h2>
      <p className="max-w-sm text-sm text-zinc-500">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
