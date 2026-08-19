import { Link } from '@tanstack/react-router'
import { AtSign, Package } from 'lucide-react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { EmptyState } from '~/components/ui/empty-state'
import type { NicheDetailData } from '~/features/niches/server'

export function NicheDetailPage({ data }: { data: NicheDetailData }) {
  const { niche, brand, products, accounts } = data

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <div className="text-xs text-zinc-400">
        <Link to="/brands" className="hover:text-zinc-600 hover:underline underline-offset-4">
          Brands
        </Link>
        {' / '}
        {brand ? (
          <Link
            to="/brands/$brandId"
            params={{ brandId: brand.id }}
            className="hover:text-zinc-600 hover:underline underline-offset-4"
          >
            {brand.name}
          </Link>
        ) : null}
        {' / '}
        <span className="text-zinc-600">{niche.name}</span>
      </div>

      <PageHeader
        title={niche.name}
        description={niche.description ?? undefined}
        actions={niche.deletedAt ? <Badge tone="muted">Archived</Badge> : undefined}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-900">Products in this niche</h2>
        {products.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No products in this niche"
            description="Add a product from the Products page and assign it to this niche."
            action={
              <Link
                to="/products"
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
              >
                Go to Products
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {products.map((product) => (
              <li
                key={product.id}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2.5"
              >
                <Link
                  to="/products/$productId"
                  params={{ productId: product.id }}
                  className="text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
                >
                  {product.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-900">Accounts in this niche</h2>
        {accounts.length === 0 ? (
          <EmptyState
            icon={AtSign}
            title="No accounts in this niche"
            description="Add an account from the Accounts page and associate it with this niche."
            action={
              <Link
                to="/accounts"
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
              >
                Go to Accounts
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <Link
                    to="/accounts/$accountId"
                    params={{ accountId: account.id }}
                    className="text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
                  >
                    {account.displayName ?? account.handle}
                  </Link>
                  <span className="text-xs text-zinc-400">
                    {account.platformName} · {account.handle}
                  </span>
                </div>
                {account.isPrimary ? <Badge tone="success">Primary niche</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
