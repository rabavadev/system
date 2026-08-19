import type { ReactNode } from 'react'

import { Sidebar } from '~/components/layout/sidebar'
import { Topbar } from '~/components/layout/topbar'

interface AppShellProps {
  children: ReactNode
  workspaceName: string | null
}

export function AppShell({ children, workspaceName }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar workspaceName={workspaceName} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
