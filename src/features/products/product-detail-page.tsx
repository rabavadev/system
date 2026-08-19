import { Link, useRouter } from '@tanstack/react-router'
import { Archive, Pencil, RotateCcw } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge, statusTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { ProductForm } from '~/features/products/product-form'
import { archiveProductFn, restoreProductFn } from '~/features/products/server'
import { cn } from '~/lib/utils'
import type { ProductSummary } from '~/server/db/product'
import type { Brand, Niche } from '~/types/domain'

/** Sections the detail page will grow into. Only Overview exists in STEP 3. */
const FUTURE_SECTIONS = ['Research', 'Campaigns', 'Content', 'Analytics', 'Files'] as const

interface ProductDetailPageProps {
  product: ProductSummary
  brands: Brand[]
  nichesByBrand: Record<string, Niche[]>
}

export function ProductDetailPage({ product, brands, nichesByBrand }: ProductDetailPageProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const archived = product.status === 'archived'

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      await action()
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <div className="text-xs text-zinc-400">
        <Link to="/products" className="hover:text-zinc-600 hover:underline underline-offset-4">
          Products
        </Link>
        {' / '}
        <span className="text-zinc-600">{product.name}</span>
      </div>

      <PageHeader
        title={product.name}
        description={undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(product.status)}>{product.status}</Badge>
            {archived ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => restoreProductFn({ data: { id: product.id } }))}
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
                  onClick={() => run(() => archiveProductFn({ data: { id: product.id } }))}
                >
                  <Archive className="size-4" strokeWidth={1.75} />
                  Archive
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Section tabs: Overview is live; the rest are placeholders for later steps. */}
      <nav className="flex items-center gap-1 border-b border-zinc-200">
        <span className="border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900">
          Overview
        </span>
        {FUTURE_SECTIONS.map((section) => (
          <span
            key={section}
            title="Coming in a later step"
            className={cn('cursor-default px-3 py-2 text-sm text-zinc-300')}
          >
            {section}
          </span>
        ))}
      </nav>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
          <dt className="text-xs font-medium text-zinc-400">Brand</dt>
          <dd className="pt-0.5 text-sm text-zinc-900">
            <Link
              to="/brands/$brandId"
              params={{ brandId: product.brandId }}
              className="hover:underline underline-offset-4"
            >
              {product.brandName}
            </Link>
          </dd>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
          <dt className="text-xs font-medium text-zinc-400">Niche</dt>
          <dd className="pt-0.5 text-sm text-zinc-900">
            {product.nicheName ? (
              <>
                {product.nicheId ? (
                  <Link
                    to="/niches/$nicheId"
                    params={{ nicheId: product.nicheId }}
                    className="hover:underline underline-offset-4"
                  >
                    {product.nicheName}
                  </Link>
                ) : (
                  product.nicheName
                )}
                {product.nicheArchived ? <span className="text-zinc-400"> (archived)</span> : null}
              </>
            ) : (
              <span className="text-zinc-400">No niche</span>
            )}
          </dd>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
          <dt className="text-xs font-medium text-zinc-400">Link</dt>
          <dd className="pt-0.5 text-sm text-zinc-900">
            {product.url ? (
              <a
                href={product.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline underline-offset-4"
              >
                {product.url}
              </a>
            ) : (
              <span className="text-zinc-400">No link</span>
            )}
          </dd>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
          <dt className="text-xs font-medium text-zinc-400">Description</dt>
          <dd className="pt-0.5 text-sm whitespace-pre-wrap text-zinc-900">
            {product.description ?? <span className="text-zinc-400">No description</span>}
          </dd>
        </div>
      </dl>

      {editing ? (
        <ProductForm
          brands={brands}
          nichesByBrand={nichesByBrand}
          product={product}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}
