import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string | undefined
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description ? <p className="text-sm text-zinc-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
