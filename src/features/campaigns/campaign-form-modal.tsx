import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import { createCampaignFn, updateCampaignFn } from '~/features/campaigns/server'
import type { AccountSummary } from '~/server/db/account'
import type { CampaignDetail, CampaignSummary } from '~/server/db/campaign'
import type { ProductSummary } from '~/server/db/product'
import type { Brand, CampaignStatus } from '~/types/domain'

interface CampaignFormModalProps {
  brands: Brand[]
  productsByBrand: Record<string, ProductSummary[]>
  allAccounts: AccountSummary[]
  campaign?: CampaignSummary | CampaignDetail | undefined
  defaultBrandId?: string | undefined
  onClose: () => void
}

function toDateInputVal(isoString: string | null | undefined): string {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
    return d.toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

export function CampaignFormModal({
  brands,
  productsByBrand,
  allAccounts,
  campaign,
  defaultBrandId,
  onClose,
}: CampaignFormModalProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const initialBrandId = campaign?.brandId ?? defaultBrandId ?? brands[0]?.id ?? ''
  const [brandId, setBrandId] = useState(initialBrandId)
  const [productId, setProductId] = useState(campaign?.productId ?? '')

  // Initial account selection
  const initialAccountIds =
    campaign && 'accounts' in campaign ? (campaign as CampaignDetail).accounts.map((a) => a.id) : []
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(initialAccountIds)

  const availableProducts = productsByBrand[brandId] ?? []

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId],
    )
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const angle = String(form.get('angle') ?? '').trim()
    const audience = String(form.get('audience') ?? '').trim()
    const status = (String(form.get('status') ?? 'draft') || 'draft') as CampaignStatus
    const startsAtVal = String(form.get('startsAt') ?? '').trim()
    const endsAtVal = String(form.get('endsAt') ?? '').trim()

    const startsAt = startsAtVal
      ? new Date(`${startsAtVal}T00:00:00.000Z`).toISOString()
      : undefined
    const endsAt = endsAtVal ? new Date(`${endsAtVal}T23:59:59.999Z`).toISOString() : undefined

    if (startsAt && endsAt && endsAt < startsAt) {
      setError('End date must be on or after start date.')
      return
    }

    setPending(true)
    setError(null)
    try {
      if (campaign) {
        await updateCampaignFn({
          data: {
            id: campaign.id,
            brandId,
            productId: productId || null,
            name,
            angle: angle || null,
            audience: audience || null,
            status,
            startsAt: startsAt ?? null,
            endsAt: endsAt ?? null,
            accountIds: selectedAccountIds,
          },
        })
      } else {
        await createCampaignFn({
          data: {
            workspaceId: brands.find((b) => b.id === brandId)?.workspaceId ?? '',
            brandId,
            productId: productId || undefined,
            name,
            angle: angle || undefined,
            audience: audience || undefined,
            status,
            startsAt,
            endsAt,
            accountIds: selectedAccountIds,
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
    <Modal title={campaign ? 'Edit campaign' : 'New campaign'} onClose={onClose}>
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-3.5 max-h-[80vh] overflow-y-auto px-1 py-1"
      >
        <Field label="Campaign name" htmlFor="campaign-name">
          <input
            id="campaign-name"
            name="name"
            required
            maxLength={200}
            defaultValue={campaign?.name}
            placeholder="e.g. Q3 Growth Push"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Brand" htmlFor="campaign-brand">
            <select
              id="campaign-brand"
              name="brandId"
              required
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value)
                setProductId('') // reset product if brand changes
              }}
              className={inputClass}
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Product (optional)" htmlFor="campaign-product">
            <select
              id="campaign-product"
              name="productId"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className={inputClass}
            >
              <option value="">No product (Brand-level)</option>
              {availableProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Objective / Description" htmlFor="campaign-angle">
          <textarea
            id="campaign-angle"
            name="angle"
            rows={2}
            maxLength={2000}
            defaultValue={campaign?.angle ?? ''}
            placeholder="Key objective, strategy notes, or angle for this campaign..."
            className={inputClass}
          />
        </Field>

        <Field label="Target Audience (optional)" htmlFor="campaign-audience">
          <input
            id="campaign-audience"
            name="audience"
            maxLength={2000}
            defaultValue={campaign?.audience ?? ''}
            placeholder="e.g. Remote product managers, indie creators"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date" htmlFor="campaign-startsAt">
            <input
              id="campaign-startsAt"
              name="startsAt"
              type="date"
              defaultValue={toDateInputVal(campaign?.startsAt)}
              className={inputClass}
            />
          </Field>
          <Field label="End date" htmlFor="campaign-endsAt">
            <input
              id="campaign-endsAt"
              name="endsAt"
              type="date"
              defaultValue={toDateInputVal(campaign?.endsAt)}
              className={inputClass}
            />
          </Field>
        </div>

        {campaign && (
          <Field label="Status" htmlFor="campaign-status">
            <select
              id="campaign-status"
              name="status"
              defaultValue={campaign.status}
              className={inputClass}
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
        )}

        {/* Account selection */}
        <div>
          <span className="block text-xs font-medium text-zinc-700 mb-1.5">
            Connected Accounts ({selectedAccountIds.length} selected)
          </span>
          {allAccounts.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">
              No accounts configured in this workspace.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-36 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50/50 p-2 text-xs">
              {allAccounts.map((acc) => (
                <label
                  key={acc.id}
                  className="flex items-center gap-2 cursor-pointer rounded px-1.5 py-1 hover:bg-zinc-100"
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.includes(acc.id)}
                    onChange={() => toggleAccount(acc.id)}
                    className="size-3.5 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                  />
                  <span className="font-medium text-zinc-800">{acc.handle}</span>
                  <span className="text-[11px] text-zinc-400">({acc.platformName})</span>
                  {acc.displayName ? (
                    <span className="text-[11px] text-zinc-500 truncate">· {acc.displayName}</span>
                  ) : null}
                </label>
              ))}
            </div>
          )}
        </div>

        {error ? <FormError message={error} /> : null}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-100 pt-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
