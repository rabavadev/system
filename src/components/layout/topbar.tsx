import { Link, useRouter } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { useTransition } from 'react'

import { type ShellData, setActiveBrand } from '~/features/workspace/server'
import { clientEnv } from '~/lib/env'

/**
 * Top bar. Shows the workspace and the active brand; the brand switcher
 * persists the selection (cookie, via server function) and refreshes the
 * shell. Chief status and notifications stay placeholders for now.
 */
export function Topbar({ shell }: { shell: ShellData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function onSelectBrand(brandId: string) {
    startTransition(async () => {
      await setActiveBrand({ data: { brandId: brandId || null } })
      await router.invalidate()
    })
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-zinc-900">
          {shell.workspaceName ?? 'Default workspace'}
        </span>
        <span className="text-zinc-300">/</span>
        {shell.brands.length > 0 ? (
          <select
            aria-label="Active brand"
            value={shell.activeBrand?.id ?? ''}
            disabled={pending}
            onChange={(event) => onSelectBrand(event.target.value)}
            className="rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm text-zinc-700 transition-colors hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
          >
            <option value="">No brand selected</option>
            {shell.brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        ) : (
          <Link
            to="/brands"
            className="text-zinc-400 underline-offset-4 hover:text-zinc-600 hover:underline"
          >
            No brand selected
          </Link>
        )}
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
