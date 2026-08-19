import { Link } from '@tanstack/react-router'

import { NAV_ITEMS } from '~/components/layout/nav-items'
import { cn } from '~/lib/utils'

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4">
        <div className="flex size-6 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white">
          G
        </div>
        <span className="text-sm font-semibold tracking-tight">Growth Workspace</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                activeOptions={{ exact: item.to === '/' }}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-zinc-600',
                  'transition-colors hover:bg-zinc-100 hover:text-zinc-900',
                )}
                activeProps={{
                  className: 'bg-zinc-100 font-medium text-zinc-900',
                }}
              >
                <item.icon className="size-4 shrink-0" strokeWidth={1.75} />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}
