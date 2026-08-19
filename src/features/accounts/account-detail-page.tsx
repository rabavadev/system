import { Link, useRouter } from '@tanstack/react-router'
import { Archive, Pencil, RotateCcw } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge, statusTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { AccountForm } from '~/features/accounts/account-form'
import { archiveAccountFn, restoreAccountFn } from '~/features/accounts/server'
import type { AccountDetail } from '~/server/db/account'
import type { Brand, Niche, Platform } from '~/types/domain'

interface AccountDetailPageProps {
  account: AccountDetail
  platforms: Platform[]
  brands: Brand[]
  nichesByBrand: Record<string, Niche[]>
}

export function AccountDetailPage({
  account,
  platforms,
  brands,
  nichesByBrand,
}: AccountDetailPageProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const archived = account.status === 'archived'

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action()
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <div className="text-xs text-zinc-400">
        <Link to="/accounts" className="hover:text-zinc-600 hover:underline underline-offset-4">
          Accounts
        </Link>
        {' / '}
        <span className="text-zinc-600">{account.displayName ?? account.handle}</span>
      </div>

      <PageHeader
        title={account.displayName ?? account.handle}
        description={`${account.platformName} · ${account.handle}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(account.status)}>{account.status}</Badge>
            {archived ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => restoreAccountFn({ data: { id: account.id } }))}
              >
                <RotateCcw className="size-4" strokeWidth={1.75} />
                Restore
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" strokeWidth={1.75} />
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() => run(() => archiveAccountFn({ data: { id: account.id } }))}
                >
                  <Archive className="size-4" strokeWidth={1.75} />
                  Archive
                </Button>
              </>
            )}
          </div>
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-900">Niches</h2>
        {account.niches.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
            No niches yet. Edit the account to associate it with the niches it posts for.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {account.niches.map((niche) => (
              <li
                key={niche.id}
                className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <Link
                    to="/niches/$nicheId"
                    params={{ nicheId: niche.id }}
                    className="text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
                  >
                    {niche.name}
                  </Link>
                  <span className="text-xs text-zinc-400">{niche.brandName}</span>
                  {niche.deletedAt ? <Badge tone="muted">Archived</Badge> : null}
                </div>
                {niche.isPrimary ? <Badge tone="success">Primary niche</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-900">Platform connection</h2>
        <p className="rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
          {account.connectionStatus === null
            ? 'Not connected. Connecting a platform account becomes available in a later step.'
            : `Connection status: ${account.connectionStatus}`}
        </p>
      </section>

      {editing ? (
        <AccountForm
          platforms={platforms}
          brands={brands}
          nichesByBrand={nichesByBrand}
          account={account}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}
