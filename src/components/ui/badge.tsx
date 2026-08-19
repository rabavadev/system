import type { ReactNode } from 'react'

import { cn } from '~/lib/utils'

type BadgeTone = 'neutral' | 'success' | 'warning' | 'muted'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-600',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  muted: 'bg-zinc-50 text-zinc-400',
}

/** Small status pill. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  )
}

/** Badge tone for entity statuses used across STEP 3 screens. */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'success'
    case 'draft':
    case 'paused':
      return 'warning'
    default:
      return 'muted'
  }
}
