import { Link, useRouter } from '@tanstack/react-router'
import { Archive, Pencil, Plus, RotateCcw, Tag } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { BrandForm } from '~/features/brands/brand-form'
import { archiveBrandFn, restoreBrandFn } from '~/features/brands/server'
import { NicheForm } from '~/features/niches/niche-form'
import { archiveNicheFn, restoreNicheFn } from '~/features/niches/server'
import { setActiveBrand } from '~/features/workspace/server'
import type { NicheSummary } from '~/server/db/niche'
import type { Brand, Niche } from '~/types/domain'

interface BrandDetailPageProps {
  brand: Brand
  niches: NicheSummary[]
  archivedNiches: Niche[]
  isActiveBrand: boolean
}

export function BrandDetailPage({
  brand,
  niches,
  archivedNiches,
  isActiveBrand,
}: BrandDetailPageProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [addingNiche, setAddingNiche] = useState(false)
  const [pending, startTransition] = useTransition()
  const archived = brand.deletedAt !== null

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action()
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title={brand.name}
        description={brand.description ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            {archived ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => restoreBrandFn({ data: { id: brand.id } }))}
              >
                <RotateCcw className="size-4" strokeWidth={1.75} />
                Restore brand
              </Button>
            ) : (
              <>
                {!isActiveBrand ? (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => run(() => setActiveBrand({ data: { brandId: brand.id } }))}
                  >
                    Set as active
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" strokeWidth={1.75} />
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() => run(() => archiveBrandFn({ data: { id: brand.id } }))}
                >
                  <Archive className="size-4" strokeWidth={1.75} />
                  Archive
                </Button>
              </>
            )}
          </div>
        }
      />

      {archived ? (
        <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
          This brand is archived. Its niches and products are kept, but hidden from selectors until
          you restore it.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">Niches</h2>
          {!archived ? (
            <Button variant="secondary" onClick={() => setAddingNiche(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              Add niche
            </Button>
          ) : null}
        </div>

        {niches.length === 0 ? (
          <EmptyState
            icon={Tag}
            title="No niches yet"
            description="Niches split a brand into the audiences or topics you grow. Add the first one."
            action={
              !archived ? (
                <Button onClick={() => setAddingNiche(true)}>
                  <Plus className="size-4" strokeWidth={1.75} />
                  Add a niche
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {niches.map((niche) => (
              <NicheRow
                key={niche.id}
                niche={niche}
                disabled={pending || archived}
                onArchive={() => run(() => archiveNicheFn({ data: { id: niche.id } }))}
              />
            ))}
          </ul>
        )}

        {archivedNiches.length > 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
              Archived niches
            </h3>
            <ul className="flex flex-col gap-1.5">
              {archivedNiches.map((niche) => (
                <li
                  key={niche.id}
                  className="flex items-center justify-between rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"
                >
                  <span className="text-sm text-zinc-500">{niche.name}</span>
                  <Button
                    variant="secondary"
                    disabled={pending || archived}
                    onClick={() => run(() => restoreNicheFn({ data: { id: niche.id } }))}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {editing ? <BrandForm brand={brand} onClose={() => setEditing(false)} /> : null}
      {addingNiche ? <NicheForm brandId={brand.id} onClose={() => setAddingNiche(false)} /> : null}
    </div>
  )
}

function NicheRow({
  niche,
  disabled,
  onArchive,
}: {
  niche: NicheSummary
  disabled: boolean
  onArchive: () => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          to="/niches/$nicheId"
          params={{ nicheId: niche.id }}
          className="truncate text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
        >
          {niche.name}
        </Link>
        <span className="text-xs text-zinc-400">
          {niche.productCount} {niche.productCount === 1 ? 'product' : 'products'} ·{' '}
          {niche.accountCount} {niche.accountCount === 1 ? 'account' : 'accounts'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={disabled}
          aria-label={`Edit ${niche.name}`}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <Pencil className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={disabled}
          aria-label={`Archive ${niche.name}`}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <Archive className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {editing ? (
        <NicheForm brandId={niche.brandId} niche={niche} onClose={() => setEditing(false)} />
      ) : null}
    </li>
  )
}
