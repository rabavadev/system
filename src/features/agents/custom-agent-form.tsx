import { useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { createCustomAgentFn } from './server'

/**
 * Create-a-custom-agent dialog. Minimum viable: name, purpose, how it runs,
 * and its instructions. Capabilities default to read-only context access;
 * external agents accept connection metadata (never secrets).
 */
export function CustomAgentForm({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [executionType, setExecutionType] = useState<'direct_model' | 'external_agent' | 'router'>(
    'direct_model',
  )
  const [instructions, setInstructions] = useState('')
  const [modelStrategy, setModelStrategy] = useState('default')
  const [endpoint, setEndpoint] = useState('')
  const [credentialRef, setCredentialRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function save() {
    setError(null)
    startTransition(async () => {
      try {
        await createCustomAgentFn({
          data: {
            name,
            ...(description.trim() ? { description: description.trim() } : {}),
            executionType,
            instructions,
            modelStrategy: modelStrategy as 'default' | 'fast' | 'reasoning' | 'cheap' | 'vision',
            capabilities: ['read_context'],
            ...(executionType === 'external_agent' && (endpoint || credentialRef)
              ? {
                  external: {
                    ...(endpoint ? { endpoint } : {}),
                    ...(credentialRef ? { credentialRef } : {}),
                  },
                }
              : {}),
          },
        })
        await onCreated()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not create the agent.')
      }
    })
  }

  return (
    <Modal title="New agent" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Name" htmlFor="agent-name">
          <input
            id="agent-name"
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
          />
        </Field>
        <Field label="Purpose" htmlFor="agent-purpose" hint="One sentence shown in the registry.">
          <input
            id="agent-purpose"
            className={inputClass}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={280}
          />
        </Field>
        <Field label="Runs with" htmlFor="agent-execution-type">
          <select
            id="agent-execution-type"
            className={inputClass}
            value={executionType}
            onChange={(event) =>
              setExecutionType(event.target.value as 'direct_model' | 'external_agent' | 'router')
            }
          >
            <option value="direct_model">Direct AI Model</option>
            <option value="external_agent">External Agent (needs connection)</option>
            <option value="router">Smart Router (not enabled yet)</option>
          </select>
        </Field>
        {executionType === 'external_agent' && (
          <>
            <Field
              label="Endpoint"
              htmlFor="agent-endpoint"
              hint="https URL of the external agent. It is stored, not called yet."
            >
              <input
                id="agent-endpoint"
                className={inputClass}
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://example.com/agent"
              />
            </Field>
            <Field
              label="Credential reference"
              htmlFor="agent-credential-ref"
              hint="The NAME of a secret stored outside the app, never the secret itself."
            >
              <input
                id="agent-credential-ref"
                className={inputClass}
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder="MY_EXTERNAL_AGENT_KEY"
              />
            </Field>
          </>
        )}
        {executionType !== 'external_agent' && (
          <Field label="Model" htmlFor="agent-model-strategy">
            <select
              id="agent-model-strategy"
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
        )}
        <Field
          label="Instructions"
          htmlFor="agent-instructions"
          hint="How this agent should think and answer."
        >
          <textarea
            id="agent-instructions"
            className={inputClass}
            rows={5}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={6000}
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim() || !instructions.trim()}>
            Create agent
          </Button>
        </div>
      </form>
    </Modal>
  )
}
