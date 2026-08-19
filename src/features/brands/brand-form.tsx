import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import { createBrandFn, updateBrandFn } from '~/features/brands/server'
import type { Brand } from '~/types/domain'

interface BrandFormProps {
  /** When set, the form edits this brand; otherwise it creates one. */
  brand?: Brand
  onClose: () => void
}

export function BrandForm({ brand, onClose }: BrandFormProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '')
    const description = String(form.get('description') ?? '')
    setPending(true)
    setError(null)
    try {
      if (brand) {
        await updateBrandFn({ data: { id: brand.id, name, description: description || null } })
      } else {
        await createBrandFn({ data: { name, description: description || undefined } })
      }
      await router.invalidate()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
      setPending(false)
    }
  }

  return (
    <Modal title={brand ? 'Edit brand' : 'New brand'} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Name" htmlFor="brand-name">
          <input
            id="brand-name"
            name="name"
            required
            maxLength={120}
            defaultValue={brand?.name}
            placeholder="e.g. Acme Digital"
            className={inputClass}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="brand-description"
          hint="Optional. One or two sentences."
        >
          <textarea
            id="brand-description"
            name="description"
            rows={3}
            maxLength={500}
            defaultValue={brand?.description ?? ''}
            placeholder="What is this brand about?"
            className={inputClass}
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : brand ? 'Save changes' : 'Create brand'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
