import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { Archive, Pencil, Plus, Tag } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { BrandForm } from '~/features/brands/brand-form'
import { archiveBrandFn, restoreBrandFn } from '~/features/brands/server'
import { setActiveBrand } from '~/features/workspace/server'

const rootApi = getRouteApi('__root__')

export function BrandsPage() {
  const router = useRouter()
  const { brands, archivedBrands } = getRouteApi('/brands').useLoaderData()
  const shell = rootApi.useLoaderData()
  const [showForm, setShowForm] = useState(false)
  const [pending, startTransition] = useTransition()

  function archive(id: string) {
    startTransition(async () => {
      await archiveBrandFn({ data: { id } })
      await router.invalidate()
    })
  }

  function restore(id: string) {
    startTransition(async () => {
      await restoreBrandFn({ data: { id } })
      await router.invalidate()
    })
  }

  function makeActive(id: string) {
    startTransition(async () => {
      await setActiveBrand({ data: { brandId: id } })
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Brands"
        description="The brands this workspace grows. Each brand holds its own niches and products."
        actions={
          brands.length > 0 ? (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              New brand
            </Button>
          ) : undefined
        }
      />

      {brands.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="Create your first brand"
          description="A brand groups the niches, products and accounts you grow it with. Everything in the workspace starts here."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              Create your first brand
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {brands.map((brand) => (
            <BrandCard
              key={brand.id}
              brand={brand}
              isActive={shell.activeBrand?.id === brand.id}
              disabled={pending}
              onArchive={() => archive(brand.id)}
              onMakeActive={() => makeActive(brand.id)}
            />
          ))}
        </ul>
      )}

      {archivedBrands.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Archived</h2>
          <ul className="flex flex-col gap-1.5">
            {archivedBrands.map((brand) => (
              <li
                key={brand.id}
                className="flex items-center justify-between rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"
              >
                <span className="text-sm text-zinc-500">{brand.name}</span>
                <Button variant="secondary" disabled={pending} onClick={() => restore(brand.id)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showForm ? <BrandForm onClose={() => setShowForm(false)} /> : null}
    </div>
  )
}

import type { BrandSummary } from '~/server/db/brand'

function BrandCard({
  brand,
  isActive,
  disabled,
  onArchive,
  onMakeActive,
}: {
  brand: BrandSummary
  isActive: boolean
  disabled: boolean
  onArchive: () => void
  onMakeActive: () => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/brands/$brandId"
            params={{ brandId: brand.id }}
            className="truncate text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
          >
            {brand.name}
          </Link>
          {isActive ? <Badge tone="success">Active</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${brand.name}`}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Pencil className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={onArchive}
            disabled={disabled}
            aria-label={`Archive ${brand.name}`}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            <Archive className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      {brand.description ? (
        <p className="line-clamp-2 text-sm text-zinc-500">{brand.description}</p>
      ) : null}
      <div className="flex items-center justify-between pt-1 text-xs text-zinc-400">
        <span>
          {brand.nicheCount} {brand.nicheCount === 1 ? 'niche' : 'niches'} · {brand.productCount}{' '}
          {brand.productCount === 1 ? 'product' : 'products'}
        </span>
        {!isActive ? (
          <button
            type="button"
            onClick={onMakeActive}
            disabled={disabled}
            className="font-medium text-zinc-500 transition-colors hover:text-zinc-900"
          >
            Set as active
          </button>
        ) : null}
      </div>
      {editing ? <BrandForm brand={brand} onClose={() => setEditing(false)} /> : null}
    </li>
  )
}
