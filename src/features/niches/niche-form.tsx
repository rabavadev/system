import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import { createNicheFn, updateNicheFn } from '~/features/niches/server'
import type { Niche } from '~/types/domain'

interface NicheFormProps {
  brandId: string
  /** When set, the form edits this niche; otherwise it creates one. */
  niche?: Niche
  onClose: () => void
}

export function NicheForm({ brandId, niche, onClose }: NicheFormProps) {
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
      if (niche) {
        await updateNicheFn({ data: { id: niche.id, name, description: description || null } })
      } else {
        await createNicheFn({ data: { brandId, name, description: description || undefined } })
      }
      await router.invalidate()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
      setPending(false)
    }
  }

  return (
    <Modal title={niche ? 'Edit niche' : 'New niche'} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Name" htmlFor="niche-name">
          <input
            id="niche-name"
            name="name"
            required
            maxLength={120}
            defaultValue={niche?.name}
            placeholder="e.g. Budget planners"
            className={inputClass}
          />
        </Field>
        <Field label="Description" htmlFor="niche-description" hint="Optional.">
          <textarea
            id="niche-description"
            name="description"
            rows={3}
            maxLength={500}
            defaultValue={niche?.description ?? ''}
            className={inputClass}
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : niche ? 'Save changes' : 'Create niche'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
