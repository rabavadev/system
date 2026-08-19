import { useQuery } from '@tanstack/react-query'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'

import { getChiefStatus } from './server'

export function SettingsPage() {
  const status = useQuery({ queryKey: ['chief-status'], queryFn: () => getChiefStatus() })

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader title="Settings" description="Workspace configuration." />

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">Chief (workspace AI)</h2>
          {status.data ? (
            <Badge tone={status.data.configured ? 'success' : 'warning'}>
              {status.data.configured ? 'Connected' : 'Not configured'}
            </Badge>
          ) : (
            <Badge tone="muted">Checking…</Badge>
          )}
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          {status.data ? status.data.detail : 'Checking whether Chief can reach a model.'}
        </p>
        {status.data && !status.data.configured && (
          <p className="mt-1 text-xs text-zinc-400">
            Setup lives in docs/ai-execution.md. Credentials are never shown here.
          </p>
        )}
      </section>
    </div>
  )
}
