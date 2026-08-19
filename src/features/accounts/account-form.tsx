import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import { createAccountFn, updateAccountFn } from '~/features/accounts/server'
import type { AccountDetail } from '~/server/db/account'
import type { Brand, Niche, Platform } from '~/types/domain'

interface AccountFormProps {
  platforms: Platform[]
  brands: Brand[]
  nichesByBrand: Record<string, Niche[]>
  /** When set, the form edits this account; otherwise it creates one. */
  account?: AccountDetail
  onClose: () => void
}

/**
 * Create/edit an account. Niches are checkboxes grouped by brand; the
 * primary niche is chosen from the checked niches only, so the submitted
 * pair is always consistent.
 */
export function AccountForm({
  platforms,
  brands,
  nichesByBrand,
  account,
  onClose,
}: AccountFormProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [selectedNiches, setSelectedNiches] = useState<string[]>(
    account?.niches.map((niche) => niche.id) ?? [],
  )
  const [primaryNicheId, setPrimaryNicheId] = useState<string | null>(
    account?.primaryNicheId ?? null,
  )

  function toggleNiche(nicheId: string) {
    setSelectedNiches((current) => {
      const next = current.includes(nicheId)
        ? current.filter((id) => id !== nicheId)
        : [...current, nicheId]
      if (primaryNicheId && !next.includes(primaryNicheId)) {
        setPrimaryNicheId(null)
      }
      return next
    })
  }

  const brandsWithNiches = brands.filter((brand) => (nichesByBrand[brand.id] ?? []).length > 0)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const handle = String(form.get('handle') ?? '')
    const displayName = String(form.get('displayName') ?? '')
    const status = String(form.get('status') ?? 'active') as 'active' | 'paused'
    setPending(true)
    setError(null)
    try {
      if (account) {
        await updateAccountFn({
          data: {
            id: account.id,
            handle,
            displayName: displayName || null,
            status,
            nicheIds: selectedNiches,
            primaryNicheId,
          },
        })
      } else {
        await createAccountFn({
          data: {
            platformId: String(form.get('platformId') ?? ''),
            handle,
            displayName: displayName || undefined,
            nicheIds: selectedNiches,
            primaryNicheId,
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
    <Modal title={account ? 'Edit account' : 'Add an account'} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {!account ? (
          <Field label="Platform" htmlFor="account-platform">
            <select id="account-platform" name="platformId" required className={inputClass}>
              {platforms.map((platform) => (
                <option key={platform.id} value={platform.id}>
                  {platform.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Handle" htmlFor="account-handle" hint="For example @yourbrand">
          <input
            id="account-handle"
            name="handle"
            required
            maxLength={100}
            defaultValue={account?.handle}
            placeholder="@yourbrand"
            className={inputClass}
          />
        </Field>
        <Field label="Display name" htmlFor="account-display-name" hint="Optional.">
          <input
            id="account-display-name"
            name="displayName"
            maxLength={120}
            defaultValue={account?.displayName ?? ''}
            className={inputClass}
          />
        </Field>

        <Field
          label="Niches"
          hint="The niches this account posts for. You can pick several, across brands."
        >
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-zinc-200 px-3 py-2">
            {brandsWithNiches.length === 0 ? (
              <p className="text-xs text-zinc-400">No niches yet. Add niches to a brand first.</p>
            ) : (
              brandsWithNiches.map((brand) => (
                <div key={brand.id} className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
                    {brand.name}
                  </span>
                  {(nichesByBrand[brand.id] ?? []).map((niche) => (
                    <label key={niche.id} className="flex items-center gap-2 text-sm text-zinc-700">
                      <input
                        type="checkbox"
                        checked={selectedNiches.includes(niche.id)}
                        onChange={() => toggleNiche(niche.id)}
                        className="size-3.5 accent-zinc-900"
                      />
                      {niche.name}
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>
        </Field>

        {selectedNiches.length > 0 ? (
          <Field
            label="Primary niche"
            htmlFor="account-primary-niche"
            hint="The main niche this account targets."
          >
            <select
              id="account-primary-niche"
              value={primaryNicheId ?? ''}
              onChange={(event) => setPrimaryNicheId(event.target.value || null)}
              className={inputClass}
            >
              <option value="">No primary niche</option>
              {brandsWithNiches.flatMap((brand) =>
                (nichesByBrand[brand.id] ?? [])
                  .filter((niche) => selectedNiches.includes(niche.id))
                  .map((niche) => (
                    <option key={niche.id} value={niche.id}>
                      {brand.name} · {niche.name}
                    </option>
                  )),
              )}
            </select>
          </Field>
        ) : null}

        {account ? (
          <Field label="Status" htmlFor="account-status">
            <select
              id="account-status"
              name="status"
              defaultValue={account.status === 'paused' ? 'paused' : 'active'}
              className={inputClass}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </Field>
        ) : null}

        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : account ? 'Save changes' : 'Add account'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
