import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { Package, Plus } from 'lucide-react'
import { useState, useTransition } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge, statusTone } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/empty-state'
import { inputClass } from '~/components/ui/form'
import { ProductForm } from '~/features/products/product-form'
import { restoreProductFn } from '~/features/products/server'

const rootApi = getRouteApi('__root__')
const routeApi = getRouteApi('/products')

export function ProductsPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { products, archivedProducts, brands, nichesByBrand } = routeApi.useLoaderData()
  const shell = rootApi.useLoaderData()
  const { brand: brandFilter } = routeApi.useSearch()
  const [showForm, setShowForm] = useState(false)
  const [pending, startTransition] = useTransition()

  const activeFilter = brandFilter ?? shell.activeBrand?.id ?? ''

  function onFilterChange(brandId: string) {
    void navigate({
      to: '/products',
      search: brandId ? { brand: brandId } : {},
      replace: true,
    })
  }

  function restore(id: string) {
    startTransition(async () => {
      await restoreProductFn({ data: { id } })
      await router.invalidate()
    })
  }

  if (brands.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <PageHeader title="Products" description="The products you promote." />
        <EmptyState
          icon={Package}
          title="Create a brand first"
          description="Products live inside a brand. Create your first brand, then add products to it."
          action={
            <Link
              to="/brands"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
            >
              Go to Brands
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Products"
        description="The products you promote."
        actions={
          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by brand"
              value={activeFilter}
              onChange={(event) => onFilterChange(event.target.value)}
              className={`${inputClass} w-auto`}
            >
              <option value="">All brands</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              Add a product
            </Button>
          </div>
        }
      />

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="A product is what your content and campaigns point at. Add the first one."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" strokeWidth={1.75} />
              Add a product
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {products.map((product) => (
            <li
              key={product.id}
              className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  to="/products/$productId"
                  params={{ productId: product.id }}
                  className="truncate text-sm font-medium text-zinc-900 hover:underline underline-offset-4"
                >
                  {product.name}
                </Link>
                <span className="text-xs text-zinc-400">
                  {product.brandName}
                  {product.nicheName
                    ? ` · ${product.nicheName}${product.nicheArchived ? ' (archived)' : ''}`
                    : ''}
                </span>
              </div>
              <Badge tone={statusTone(product.status)}>{product.status}</Badge>
            </li>
          ))}
        </ul>
      )}

      {archivedProducts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Archived</h2>
          <ul className="flex flex-col gap-1.5">
            {archivedProducts.map((product) => (
              <li
                key={product.id}
                className="flex items-center justify-between rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"
              >
                <span className="text-sm text-zinc-500">{product.name}</span>
                <Button variant="secondary" disabled={pending} onClick={() => restore(product.id)}>
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showForm ? (
        <ProductForm
          brands={brands}
          nichesByBrand={nichesByBrand}
          defaultBrandId={activeFilter || undefined}
          onClose={() => setShowForm(false)}
        />
      ) : null}
    </div>
  )
}
