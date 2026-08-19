import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import { createProductFn, updateProductFn } from '~/features/products/server'
import type { ProductSummary } from '~/server/db/product'
import type { Brand, Niche } from '~/types/domain'

interface ProductFormProps {
  brands: Brand[]
  nichesByBrand: Record<string, Niche[]>
  /** When set, the form edits this product; otherwise it creates one. */
  product?: ProductSummary
  /** Preselected brand for new products (usually the active brand). */
  defaultBrandId?: string | undefined
  onClose: () => void
}

export function ProductForm({
  brands,
  nichesByBrand,
  product,
  defaultBrandId,
  onClose,
}: ProductFormProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [brandId, setBrandId] = useState(product?.brandId ?? defaultBrandId ?? brands[0]?.id ?? '')

  const niches = nichesByBrand[brandId] ?? []

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '')
    const description = String(form.get('description') ?? '')
    const url = String(form.get('url') ?? '')
    const nicheId = String(form.get('nicheId') ?? '') || null
    const status = String(form.get('status') ?? 'draft') as 'draft' | 'active'
    setPending(true)
    setError(null)
    try {
      if (product) {
        await updateProductFn({
          data: {
            id: product.id,
            brandId,
            nicheId,
            name,
            description: description || null,
            url: url || null,
            status,
          },
        })
      } else {
        await createProductFn({
          data: {
            brandId,
            nicheId,
            name,
            description: description || undefined,
            url: url || undefined,
            status,
          },
        })
      }
      await router.invalidate()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
      setPending(false)
    }
  }

  return (
    <Modal title={product ? 'Edit product' : 'New product'} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Name" htmlFor="product-name">
          <input
            id="product-name"
            name="name"
            required
            maxLength={160}
            defaultValue={product?.name}
            placeholder="e.g. Budget Planner Spreadsheet"
            className={inputClass}
          />
        </Field>
        <Field label="Brand" htmlFor="product-brand">
          <select
            id="product-brand"
            name="brandId"
            required
            value={brandId}
            onChange={(event) => setBrandId(event.target.value)}
            className={inputClass}
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Niche"
          htmlFor="product-niche"
          hint="Optional. The niches of the selected brand."
        >
          <select
            id="product-niche"
            name="nicheId"
            defaultValue={product?.nicheId ?? ''}
            key={brandId}
            className={inputClass}
          >
            <option value="">No niche</option>
            {niches.map((niche) => (
              <option key={niche.id} value={niche.id}>
                {niche.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Link" htmlFor="product-url" hint="Optional. Where the product can be bought.">
          <input
            id="product-url"
            name="url"
            type="url"
            maxLength={500}
            defaultValue={product?.url ?? ''}
            placeholder="https://…"
            className={inputClass}
          />
        </Field>
        <Field label="Description" htmlFor="product-description" hint="Optional.">
          <textarea
            id="product-description"
            name="description"
            rows={3}
            maxLength={2000}
            defaultValue={product?.description ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Status" htmlFor="product-status">
          <select
            id="product-status"
            name="status"
            defaultValue={product?.status === 'active' ? 'active' : 'draft'}
            className={inputClass}
          >
            <option value="draft">Draft</option>
            <option value="active">Active</option>
          </select>
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : product ? 'Save changes' : 'Create product'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
