import { getRouteApi, Link } from '@tanstack/react-router'
import { AtSign, Package, Plus, Tag } from 'lucide-react'

import { PageHeader } from '~/components/layout/page-header'
import { EmptyState } from '~/components/ui/empty-state'

const routeApi = getRouteApi('/')
const rootApi = getRouteApi('__root__')

export function HomePage() {
  const { brandCount, productCount, accountCount } = routeApi.useLoaderData()
  const shell = rootApi.useLoaderData()

  if (brandCount === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <PageHeader title="Home" description="Your workspace overview." />
        <EmptyState
          icon={Tag}
          title="Create your first brand"
          description="Everything starts with a brand: it holds your niches, products and accounts."
          action={
            <Link
              to="/brands"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              <Plus className="size-4" strokeWidth={1.75} />
              Create your first brand
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Home"
        description={
          shell.activeBrand ? `Working on ${shell.activeBrand.name}.` : 'Your workspace overview.'
        }
      />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <li>
          <Link
            to="/brands"
            className="flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
              <Tag className="size-3.5" strokeWidth={1.75} />
              Brands
            </span>
            <span className="text-lg font-semibold text-zinc-900">{brandCount}</span>
          </Link>
        </li>
        <li>
          <Link
            to="/products"
            className="flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
              <Package className="size-3.5" strokeWidth={1.75} />
              Products
            </span>
            <span className="text-lg font-semibold text-zinc-900">{productCount}</span>
          </Link>
        </li>
        <li>
          <Link
            to="/accounts"
            className="flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
              <AtSign className="size-3.5" strokeWidth={1.75} />
              Accounts
            </span>
            <span className="text-lg font-semibold text-zinc-900">{accountCount}</span>
          </Link>
        </li>
      </ul>
    </div>
  )
}
