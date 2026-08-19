import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { CAPABILITY_LABEL } from './labels'
import { type AgentVersionItem, saveAgentVersionFn } from './server'

const ALL_CAPABILITIES = [
  'read_context',
  'read_memory',
  'read_research',
  'read_analytics',
  'create_draft',
  'propose_memory',
  'request_workflow',
  'publish',
  'modify_account',
] as const

/**
 * Edit an agent's versioned configuration. Saving ALWAYS creates version
 * N+1 — the current version is never mutated, so historical executions keep
 * pointing at the exact configuration that produced them.
 */
export function AgentVersionForm({
  agentId,
  current,
  onClose,
  onSaved,
}: {
  agentId: string
  current: AgentVersionItem
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const [instructions, setInstructions] = useState(current.instructions)
  const [modelStrategy, setModelStrategy] = useState(current.modelStrategy)
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set(current.capabilities))
  const [changeNote, setChangeNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function toggleCapability(capability: string) {
    setCapabilities((value) => {
      const next = new Set(value)
      if (next.has(capability)) {
        next.delete(capability)
      } else {
        next.add(capability)
      }
      return next
    })
  }

  function save() {
    setError(null)
    startTransition(async () => {
      try {
        await saveAgentVersionFn({
          data: {
            id: agentId,
            instructions,
            modelStrategy: modelStrategy as 'default' | 'fast' | 'reasoning' | 'cheap' | 'vision',
            capabilities: [...capabilities] as Array<(typeof ALL_CAPABILITIES)[number]>,
            ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
          },
        })
        await onSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save the new version.')
      }
    })
  }

  return (
    <Modal title={`Edit (creates version ${current.version + 1})`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Instructions" htmlFor="version-instructions">
          <textarea
            id="version-instructions"
            className={inputClass}
            rows={8}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={6000}
          />
        </Field>
        <Field label="Model" htmlFor="version-model-strategy">
          <select
            id="version-model-strategy"
            className={inputClass}
            value={modelStrategy}
            onChange={(event) => setModelStrategy(event.target.value)}
          >
            <option value="default">Default</option>
            <option value="fast">Fast</option>
            <option value="reasoning">Reasoning</option>
            <option value="cheap">Budget</option>
            <option value="vision">Vision</option>
          </select>
        </Field>
        <Field label="Capabilities" hint="Declared intent only — tools are not built yet.">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {ALL_CAPABILITIES.map((capability) => (
              <label key={capability} className="flex items-center gap-1.5 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={capabilities.has(capability)}
                  onChange={() => toggleCapability(capability)}
                />
                {CAPABILITY_LABEL[capability] ?? capability}
              </label>
            ))}
          </div>
        </Field>
        <Field
          label="Change note"
          htmlFor="version-change-note"
          hint="Optional. Shown in the version history."
        >
          <input
            id="version-change-note"
            className={inputClass}
            value={changeNote}
            onChange={(event) => setChangeNote(event.target.value)}
            maxLength={200}
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !instructions.trim()}>
            Save new version
          </Button>
        </div>
      </form>
    </Modal>
  )
}
