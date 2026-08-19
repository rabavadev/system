import type { ReactNode } from 'react'

import { Sidebar } from '~/components/layout/sidebar'
import { Topbar } from '~/components/layout/topbar'
import type { ShellData } from '~/features/workspace/server'

interface AppShellProps {
  children: ReactNode
  shell: ShellData
}

export function AppShell({ children, shell }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar shell={shell} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
