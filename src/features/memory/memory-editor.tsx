import { useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { MemoryClass, MemoryScopeType } from '~/types/domain'

import type { MemoryListItem, MemoryScopeOptions } from './server'
import { createMemoryFn, supersedeMemoryFn, updateMemoryFn, verifyMemoryFn } from './server'
import type { ConfidenceLevelWire } from './wire'

type EditorMode = 'create' | 'edit' | 'verify' | 'supersede' | 'message'

interface MemoryEditorDialogProps {
  mode: EditorMode
  scopeOptions: MemoryScopeOptions
  memory?: MemoryListItem | undefined
  initialContent?: string | undefined
  initialClass?: MemoryClass | undefined
  initialScope?: { scopeType: MemoryScopeType; scopeId: string | null } | undefined
  sourceMessageId?: string | undefined
  onClose: () => void
  onSaved?: (memory: MemoryListItem) => void
}

const TYPE_HELP: Record<MemoryClass, string> = {
  permanent_fact: 'Stable information Chief should keep using until you change it.',
  verified_learning: 'A finding backed by evidence.',
  proposed_learning: 'A hypothesis that still needs review.',
  temporary_context: 'Short-lived context for current work.',
}

const TYPE_OPTIONS: { value: MemoryClass; label: string }[] = [
  { value: 'permanent_fact', label: 'Important Fact' },
  { value: 'verified_learning', label: 'Verified Learning' },
  { value: 'proposed_learning', label: 'Needs Verification' },
  { value: 'temporary_context', label: 'Temporary' },
]

function encodeScope(type: string, id: string | null): string {
  return type === 'workspace' ? 'workspace' : `${type}:${id}`
}

function decodeScope(value: string): { scopeType: string; scopeId: string | null } {
  if (value === 'workspace') return { scopeType: 'workspace', scopeId: null }
  const [scopeType, scopeId] = value.split(':')
  return { scopeType: scopeType || 'workspace', scopeId: scopeId || null }
}

function toDateTimeInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromDateTimeInput(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function ScopeSelect({
  value,
  onChange,
  options,
  includeAll = false,
}: {
  value: string
  onChange: (value: string) => void
  options: MemoryScopeOptions
  includeAll?: boolean
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
      {includeAll ? <option value="">Everything</option> : null}
      <option value="workspace">Whole workspace</option>
      {options.brands.length > 0 ? (
        <optgroup label="Brands">
          {options.brands.map((brand) => (
            <option key={brand.id} value={encodeScope('brand', brand.id)}>
              {brand.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {options.niches.length > 0 ? (
        <optgroup label="Niches">
          {options.niches.map((niche) => (
            <option key={niche.id} value={encodeScope('niche', niche.id)}>
              {niche.brandName} / {niche.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {options.products.length > 0 ? (
        <optgroup label="Products">
          {options.products.map((product) => (
            <option key={product.id} value={encodeScope('product', product.id)}>
              {product.brandName} / {product.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {options.accounts.length > 0 ? (
        <optgroup label="Accounts">
          {options.accounts.map((account) => (
            <option key={account.id} value={encodeScope('account', account.id)}>
              {account.name} / {account.platformName}
            </option>
          ))}
        </optgroup>
      ) : null}
      {options.platforms.length > 0 ? (
        <optgroup label="Platforms">
          {options.platforms.map((platform) => (
            <option key={platform.id} value={encodeScope('platform', platform.id)}>
              {platform.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {options.campaigns.length > 0 ? (
        <optgroup label="Campaigns">
          {options.campaigns.map((campaign) => (
            <option key={campaign.id} value={encodeScope('campaign', campaign.id)}>
              {campaign.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  )
}

export function MemoryEditorDialog({
  mode,
  scopeOptions,
  memory,
  initialContent,
  initialClass,
  initialScope,
  sourceMessageId,
  onClose,
  onSaved,
}: MemoryEditorDialogProps) {
  const router = useRouter()
  const isVerify = mode === 'verify'
  const fixedClass = memory?.memoryClass
  const [memoryClass, setMemoryClass] = useState<MemoryClass>(
    fixedClass ?? initialClass ?? 'permanent_fact',
  )
  const [content, setContent] = useState(memory?.content ?? initialContent ?? '')
  const [scope, setScope] = useState(
    memory
      ? encodeScope(memory.scopeType, memory.scopeId)
      : initialScope
        ? encodeScope(initialScope.scopeType, initialScope.scopeId)
        : 'workspace',
  )
  const [confidence, setConfidence] = useState<ConfidenceLevelWire | ''>(
    memory?.confidenceLabel === 'Low'
      ? 'low'
      : memory?.confidenceLabel === 'Medium'
        ? 'medium'
        : memory?.confidenceLabel === 'High'
          ? 'high'
          : memoryClass === 'verified_learning'
            ? 'medium'
            : '',
  )
  const [evidence, setEvidence] = useState(memory?.evidenceText ?? '')
  const [evidenceDirty, setEvidenceDirty] = useState(false)
  const [expiresAt, setExpiresAt] = useState(toDateTimeInput(memory?.expiresAt ?? null))
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const showConfidence = memoryClass === 'verified_learning' || memoryClass === 'proposed_learning'
  const showEvidence = showConfidence
  const title =
    mode === 'edit'
      ? 'Edit memory'
      : mode === 'verify'
        ? 'Verify learning'
        : mode === 'supersede'
          ? 'Replace memory'
          : mode === 'message'
            ? 'Review before saving to Memory'
            : 'New memory'

  function submit() {
    setError(null)
    const selected = decodeScope(scope)
    startTransition(async () => {
      try {
        let saved: MemoryListItem
        if (mode === 'verify' && memory) {
          saved = await verifyMemoryFn({
            data: {
              id: memory.id,
              confidenceLevel: confidence || 'medium',
              evidence,
            },
          })
        } else if (mode === 'edit' && memory) {
          saved = await updateMemoryFn({
            data: {
              id: memory.id,
              content,
              scopeType: selected.scopeType as MemoryScopeType,
              scopeId: selected.scopeId,
              confidenceLevel: showConfidence ? confidence || null : null,
              ...(showEvidence && evidenceDirty ? { evidence } : {}),
              expiresAt: fromDateTimeInput(expiresAt),
            },
          })
        } else if (mode === 'supersede' && memory) {
          saved = await supersedeMemoryFn({
            data: {
              id: memory.id,
              content,
              scopeType: selected.scopeType as MemoryScopeType,
              scopeId: selected.scopeId,
              confidenceLevel: showConfidence ? confidence || null : null,
              evidence: showEvidence ? evidence : undefined,
              expiresAt: fromDateTimeInput(expiresAt),
            },
          })
        } else {
          saved = await createMemoryFn({
            data: {
              memoryClass,
              content,
              scopeType: selected.scopeType as MemoryScopeType,
              scopeId: selected.scopeId,
              confidenceLevel: showConfidence ? confidence || null : null,
              evidence: showEvidence ? evidence : undefined,
              expiresAt: fromDateTimeInput(expiresAt),
              sourceMessageId: sourceMessageId ?? null,
            },
          })
        }
        await router.invalidate()
        onSaved?.(saved)
        onClose()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Memory could not be saved.')
      }
    })
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        className="flex flex-col gap-3"
      >
        {mode === 'create' || mode === 'message' ? (
          <Field label="Type" htmlFor="memory-type" hint={TYPE_HELP[memoryClass]}>
            <select
              id="memory-type"
              value={memoryClass}
              onChange={(event) => {
                const next = event.target.value as MemoryClass
                setMemoryClass(next)
                if (next === 'verified_learning' && !confidence) setConfidence('medium')
                if (next === 'temporary_context') setConfidence('')
              }}
              className={inputClass}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="rounded-md bg-zinc-50 px-2.5 py-2 text-xs text-zinc-500">
            {TYPE_HELP[memoryClass]}
          </p>
        )}

        <Field label="Memory" htmlFor="memory-content">
          <textarea
            id="memory-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            readOnly={isVerify}
            rows={5}
            maxLength={4000}
            className={`${inputClass} resize-y leading-6`}
          />
        </Field>

        {!isVerify ? (
          <Field label="Applies to" htmlFor="memory-scope">
            <ScopeSelect value={scope} onChange={setScope} options={scopeOptions} />
          </Field>
        ) : null}

        {showConfidence ? (
          <Field label="Confidence" htmlFor="memory-confidence">
            <select
              id="memory-confidence"
              value={confidence}
              onChange={(event) => setConfidence(event.target.value as ConfidenceLevelWire | '')}
              className={inputClass}
            >
              <option value="">Not set</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
        ) : null}

        {showEvidence ? (
          <Field
            label="Evidence"
            htmlFor="memory-evidence"
            hint={
              memoryClass === 'verified_learning'
                ? 'Briefly say what supports this learning.'
                : 'Optional until you verify it.'
            }
          >
            <textarea
              id="memory-evidence"
              value={evidence}
              onChange={(event) => {
                setEvidence(event.target.value)
                setEvidenceDirty(true)
              }}
              rows={3}
              maxLength={2000}
              className={`${inputClass} resize-y leading-6`}
            />
          </Field>
        ) : null}

        {!isVerify ? (
          <Field
            label="Expires"
            htmlFor="memory-expiry"
            hint="Optional. Use this mainly for temporary or time-sensitive memory."
          >
            <input
              id="memory-expiry"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className={inputClass}
            />
          </Field>
        ) : null}

        {mode === 'message' ? (
          <p className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-700">
            Review this before saving. Chief messages only become memory when you choose to save
            them.
          </p>
        ) : null}
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button type="submit" disabled={pending || content.trim().length === 0}>
            {mode === 'verify' ? 'Verify' : mode === 'supersede' ? 'Replace' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
