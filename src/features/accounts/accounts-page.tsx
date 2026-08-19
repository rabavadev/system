import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { AtSign, Plus } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge, statusTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { AccountForm } from '~/features/accounts/account-form'
import { restoreAccountFn } from '~/features/accounts/server'

const routeApi = getRouteApi('/accounts')

export function AccountsPage() {
  const router = useRouter()
  const { accounts, archivedAccounts, platforms, brands, nichesByBrand } = routeApi.useLoaderData()
  const [showForm, setShowForm] = useState(false)
  const [pending, startTransition] = useTransition()

  function restore(id: string) {
    startTransition(async () => {
      await restoreAccountFn({ data: { id } })
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Accounts"
        description="Social and content accounts this workspace publishes through."
        actions={
          <Button onClick={() => setShowForm(true)}>
            <Plus className="size-4" strokeWidth={1.75} />
            Add an account
          </Button>
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          icon={AtSign}
          title="No accounts yet"
          description="An account is a profile on a platform, like your Instagram or TikTok handle. Add one to plan what it posts."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              Add an account
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Link
                    to="/accounts/$accountId"
                    params={{ accountId: account.id }}
                    className="truncate text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
                  >
                    {account.displayName ?? account.handle}
                  </Link>
                  <Badge tone={statusTone(account.status)}>{account.status}</Badge>
                </div>
                <span className="text-xs text-zinc-400">
                  {account.platformName} · {account.handle}
                  {account.nicheNames.length > 0 ? ` · ${account.nicheNames.join(', ')}` : ''}
                </span>
              </div>
              {account.connectionStatus === null ? (
                <span className="shrink-0 text-xs text-zinc-400">Not connected</span>
              ) : (
                <Badge tone={account.connectionStatus === 'connected' ? 'success' : 'warning'}>
                  {account.connectionStatus}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {archivedAccounts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Archived</h2>
          <ul className="flex flex-col gap-1.5">
            {archivedAccounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"
              >
                <span className="text-sm text-zinc-500">
                  {account.displayName ?? account.handle}
                </span>
                <Button variant="secondary" disabled={pending} onClick={() => restore(account.id)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showForm ? (
        <AccountForm
          platforms={platforms}
          brands={brands}
          nichesByBrand={nichesByBrand}
          onClose={() => setShowForm(false)}
        />
      ) : null}
    </div>
  )
}
