import { Link, useRouter } from '@tanstack/react-router'
import { Archive, CheckCircle2, ExternalLink, LogOut, Pencil, RotateCcw } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge, statusTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { AccountForm } from '~/features/accounts/account-form'
import {
  archiveAccountFn,
  disconnectXAccountFn,
  restoreAccountFn,
  startXOAuthConnectionFn,
} from '~/features/accounts/server'
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
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const archived = account.status === 'archived'

  const platform = platforms.find((p) => p.id === account.platformId)
  const isXPlatform =
    platform?.adapterKey.toLowerCase() === 'x' || account.platformName.toLowerCase() === 'x'

  const isConnected = account.connectionStatus === 'connected'

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action()
      await router.invalidate()
    })
  }

  async function handleConnectX() {
    setOauthError(null)
    setConnecting(true)
    try {
      const result = await startXOAuthConnectionFn({ data: { id: account.id } })
      if (!result.ok) {
        setOauthError(result.reason)
        setConnecting(false)
        return
      }
      // Redirect browser to X authorization page
      window.location.href = result.url
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Failed to initiate X connection.')
      setConnecting(false)
    }
  }

  async function handleDisconnectX() {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true)
      return
    }
    setDisconnectError(null)
    setDisconnecting(true)
    try {
      const result = await disconnectXAccountFn({ data: { id: account.id } })
      if (!result.ok) {
        setDisconnectError(result.reason)
        setDisconnecting(false)
        setConfirmDisconnect(false)
        return
      }
      setConfirmDisconnect(false)
      await router.invalidate()
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : 'Failed to disconnect X account.')
      setDisconnecting(false)
      setConfirmDisconnect(false)
    }
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
        <div className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-900">{account.platformName}</span>
              {isConnected ? (
                <Badge tone="success">Connected</Badge>
              ) : (
                <Badge tone="muted">Not connected</Badge>
              )}
            </div>

            {isXPlatform && !archived ? (
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <>
                    {confirmDisconnect ? (
                      <>
                        <span className="text-xs text-zinc-500">Disconnect from X?</span>
                        <Button
                          variant="danger"
                          disabled={disconnecting}
                          id="confirm-disconnect-x"
                          onClick={handleDisconnectX}
                        >
                          <LogOut className="size-4" strokeWidth={1.75} />
                          {disconnecting ? 'Disconnecting…' : 'Confirm'}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={disconnecting}
                          onClick={() => setConfirmDisconnect(false)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={connecting || pending || disconnecting}
                        id="disconnect-x"
                        onClick={handleDisconnectX}
                      >
                        <LogOut className="size-4" strokeWidth={1.75} />
                        Disconnect X
                      </Button>
                    )}
                  </>
                ) : null}
                <Button
                  variant={isConnected ? 'secondary' : 'primary'}
                  disabled={connecting || pending || disconnecting}
                  onClick={handleConnectX}
                >
                  <ExternalLink className="size-4" strokeWidth={1.75} />
                  {connecting ? 'Connecting…' : isConnected ? 'Reconnect X' : 'Connect X'}
                </Button>
              </div>
            ) : null}
          </div>

          {isConnected ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 className="size-3.5" />
              Connected as {account.handle}
            </p>
          ) : (
            <p className="text-xs text-zinc-500">
              {isXPlatform
                ? 'Link your X account using OAuth 2.0 PKCE to enable authorized post publishing.'
                : 'Connecting a platform account becomes available in a later step.'}
            </p>
          )}

          {oauthError ? (
            <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">
              Connection failed: {oauthError}
            </p>
          ) : null}

          {disconnectError ? (
            <p className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">
              Disconnect failed: {disconnectError}
            </p>
          ) : null}
        </div>
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
