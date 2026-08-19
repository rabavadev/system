import { Bell } from 'lucide-react'

import { clientEnv } from '~/lib/env'

/**
 * Top bar. Slots for workspace, brand, Chief status and notifications are
 * rendered as static placeholders until those systems exist.
 */
export function Topbar({ workspaceName }: { workspaceName: string | null }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-zinc-900">{workspaceName ?? 'Default workspace'}</span>
        <span className="text-zinc-300">/</span>
        <span className="text-zinc-400">No brand selected</span>
        {clientEnv.appEnv !== 'production' ? (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
            {clientEnv.appEnv}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="size-1.5 rounded-full bg-zinc-300" aria-hidden />
          Chief idle
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          aria-label="Notifications"
        >
          <Bell className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
