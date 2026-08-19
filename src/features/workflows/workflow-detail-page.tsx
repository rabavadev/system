import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { Archive, ChevronRight, Pencil, Play, Power } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { RUN_STATUS_LABEL, runStatusTone, STEP_TYPE_LABEL, WORKFLOW_STATUS_LABEL } from './labels'
import {
  type getWorkflowDetailData,
  saveWorkflowDefinition,
  setWorkflowStatusFn,
  startWorkflowRunFn,
} from './server'
import { editorStateFrom, WorkflowEditor } from './workflow-editor'

const routeApi = getRouteApi('/workflows_/$workflowId')

export function WorkflowDetailPage() {
  const router = useRouter()
  const data = routeApi.useLoaderData()
  const [editing, setEditing] = useState(false)
  const [showRun, setShowRun] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const { workflow, definition, versions, runs, agents, tools, entities } = data

  async function saveDefinition(definitionData: unknown) {
    setSaving(true)
    setErrors([])
    setWarnings([])
    const result = await saveWorkflowDefinition({
      data: { workflowId: workflow.id, definition: definitionData, changeNote: 'Edited' },
    })
    setSaving(false)
    if (!result.ok) {
      setErrors([result.message])
      return
    }
    setEditing(false)
    await router.invalidate()
  }

  async function changeStatus(status: 'active' | 'disabled' | 'archived') {
    const result = await setWorkflowStatusFn({ data: { id: workflow.id, status } })
    if (!result.ok) {
      setErrors([result.message])
      return
    }
    await router.invalidate()
  }

  const canRun = workflow.status === 'active' && definition !== null

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title={workflow.name}
        description={workflow.purpose ?? 'No description yet.'}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={workflow.status === 'active' ? 'success' : 'muted'}>
              {WORKFLOW_STATUS_LABEL[workflow.status]}
            </Badge>
            {canRun && (
              <Button onClick={() => setShowRun(true)}>
                <Play className="size-4" strokeWidth={1.75} />
                Run
              </Button>
            )}
            <Button variant="secondary" onClick={() => setEditing((value) => !value)}>
              <Pencil className="size-4" strokeWidth={1.75} />
              {definition ? 'Edit steps' : 'Add steps'}
            </Button>
            {workflow.status === 'active' ? (
              <Button variant="secondary" onClick={() => changeStatus('disabled')}>
                <Power className="size-4" strokeWidth={1.75} />
                Disable
              </Button>
            ) : workflow.status !== 'archived' ? (
              <Button variant="secondary" onClick={() => changeStatus('active')}>
                <Power className="size-4" strokeWidth={1.75} />
                Activate
              </Button>
            ) : null}
            {workflow.status !== 'archived' && (
              <Button variant="secondary" onClick={() => changeStatus('archived')}>
                <Archive className="size-4" strokeWidth={1.75} />
                Archive
              </Button>
            )}
          </div>
        }
      />

      {editing && (
        <WorkflowEditor
          initial={
            definition
              ? editorStateFrom(definition)
              : { inputs: [], steps: [], outputStepId: '', outputPath: '' }
          }
          agents={agents}
          tools={tools}
          saving={saving}
          errors={errors}
          warnings={warnings}
          onSave={saveDefinition}
          onCancel={() => {
            setEditing(false)
            setErrors([])
          }}
        />
      )}

      {definition && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">How it runs</h2>
          <ol className="overflow-hidden rounded-md border border-zinc-200 bg-white">
            {definition.steps.map((step, index) => (
              <li
                key={step.id}
                className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-b-0"
              >
                <span className="text-xs text-zinc-400">{index + 1}.</span>
                <Badge tone="neutral">{STEP_TYPE_LABEL[step.type]}</Badge>
                <StepSummary step={step} agents={agents} tools={tools} />
              </li>
            ))}
          </ol>
          <p className="text-xs text-zinc-400">
            Saved as version {versions.find((v) => v.isCurrent)?.version ?? 1}. Editing creates a
            new version; earlier runs keep theirs.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-200 px-4 py-4 text-xs text-zinc-400">
            Not run yet.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-md border border-zinc-200 bg-white">
            {runs.map((run) => (
              <li key={run.id} className="border-b border-zinc-100 last:border-b-0">
                <Link
                  to="/workflows/$workflowId/runs/$runId"
                  params={{ workflowId: workflow.id, runId: run.id }}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-zinc-50"
                >
                  <Badge tone={runStatusTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
                  <span className="text-xs text-zinc-500">
                    v{run.version} · {new Date(run.createdAt).toLocaleString()}
                  </span>
                  {run.error && (
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                      {run.error}
                    </span>
                  )}
                  <ChevronRight className="ml-auto size-4 text-zinc-300" strokeWidth={1.75} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
          Version history
        </h2>
        <ul className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-b-0"
            >
              <span className="text-sm font-medium text-zinc-900">v{version.version}</span>
              <span className="text-xs text-zinc-500">
                {version.stepCount} step{version.stepCount === 1 ? '' : 's'}
                {version.changeNote ? ` · ${version.changeNote}` : ''}
              </span>
              {version.isCurrent && <Badge tone="success">Current</Badge>}
              <span className="ml-auto text-xs text-zinc-400">
                {new Date(version.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {showRun && definition && (
        <RunWorkflowModal
          workflowId={workflow.id}
          definition={definition}
          entities={entities}
          onClose={() => setShowRun(false)}
          onStarted={async (runId) => {
            setShowRun(false)
            await router.invalidate()
            router.navigate({
              to: '/workflows/$workflowId/runs/$runId',
              params: { workflowId: workflow.id, runId },
            })
          }}
        />
      )}
    </div>
  )
}

function StepSummary({
  step,
  agents,
  tools,
}: {
  step: NonNullable<Awaited<ReturnType<typeof getWorkflowDetailData>>>['definition'] extends null
    ? never
    : import('~/server/workflows').WorkflowStepDef
  agents: { id: string; name: string }[]
  tools: { key: string; name: string }[]
}) {
  if (step.type === 'agent') {
    const agent = agents.find((a) => a.id === step.agent.agentId)
    return (
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">
        <span className="font-medium text-zinc-800">{agent?.name ?? 'Unknown agent'}</span>
        {' — '}
        {step.task}
        {step.agent.versionPolicy === 'pinned' ? ' (fixed version)' : ''}
      </span>
    )
  }
  if (step.type === 'tool') {
    const tool = tools.find((t) => t.key === step.toolKey)
    const agent = agents.find((a) => a.id === step.requestedBy.agentId)
    return (
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">
        <span className="font-medium text-zinc-800">{tool?.name ?? step.toolKey}</span>
        {agent ? ` requested by ${agent.name}` : ''}
      </span>
    )
  }
  if (step.type === 'condition') {
    return (
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">
        If the check passes go to {step.branches.yes ?? 'the end'}, otherwise{' '}
        {step.branches.no ?? 'the end'}.
      </span>
    )
  }
  return <span className="flex-1 text-xs text-zinc-600">The workflow ends here.</span>
}

/* ---- run dialog ---- */

function RunWorkflowModal({
  workflowId,
  definition,
  entities,
  onClose,
  onStarted,
}: {
  workflowId: string
  definition: import('~/server/workflows').WorkflowDefinition
  entities: {
    brands: { id: string; name: string }[]
    products: { id: string; name: string; brandId: string }[]
    accounts: { id: string; name: string }[]
  }
  onClose: () => void
  onStarted: (runId: string) => void | Promise<void>
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    const result = await startWorkflowRunFn({ data: { workflowId, inputs: values } })
    if (!result.ok) {
      setError(result.message)
      setBusy(false)
      return
    }
    await onStarted(result.runId)
  }

  const optionsFor = (kind: string) => {
    switch (kind) {
      case 'brand':
        return entities.brands
      case 'product':
        return entities.products
      case 'account':
        return entities.accounts
      default:
        return []
    }
  }

  return (
    <Modal title="Run this workflow" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {definition.inputs.length === 0 && (
          <p className="text-xs text-zinc-500">
            This workflow needs nothing extra. It will run with the workspace context.
          </p>
        )}
        {definition.inputs.map((input) => (
          <Field
            key={input.key}
            label={input.label}
            {...(input.required ? {} : { hint: 'Optional.' })}
          >
            {input.kind === 'text' ? (
              <input
                className={inputClass}
                value={values[input.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [input.key]: e.target.value }))}
              />
            ) : (
              <select
                className={inputClass}
                value={values[input.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [input.key]: e.target.value }))}
              >
                <option value="">Choose…</option>
                {optionsFor(input.kind).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
