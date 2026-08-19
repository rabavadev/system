import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { ChevronRight, Plus, Workflow } from 'lucide-react'
import { useState } from 'react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { RUN_STATUS_LABEL, runStatusTone, WORKFLOW_STATUS_LABEL } from './labels'
import { createWorkflowShell, type WorkflowListItem } from './server'

const routeApi = getRouteApi('/workflows')

export function WorkflowsPage() {
  const { workflows } = routeApi.useLoaderData()
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title="Workflows"
        description="Repeatable processes your agents run step by step. Define the steps once, then run the workflow whenever you need it."
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4" strokeWidth={1.75} />
            New workflow
          </Button>
        }
      />

      {workflows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-zinc-200 px-4 py-6">
          <Workflow className="size-4 text-zinc-300" strokeWidth={1.75} />
          <p className="text-sm text-zinc-400">
            No workflows yet. Create one to chain agents together, like a review that runs a
            strategist and then a critic.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-md border border-zinc-200 bg-white">
          {workflows.map((workflow) => (
            <WorkflowRow key={workflow.id} workflow={workflow} />
          ))}
        </ul>
      )}

      {showCreate && <CreateWorkflowModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}

function WorkflowRow({ workflow }: { workflow: WorkflowListItem }) {
  return (
    <li className="border-b border-zinc-100 last:border-b-0">
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-zinc-50"
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="shrink-0 text-sm font-medium text-zinc-900">{workflow.name}</span>
          <span className="truncate text-xs text-zinc-500">
            {workflow.purpose ?? 'No description yet.'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {workflow.lastRun && (
            <span className="hidden text-xs text-zinc-400 sm:inline">
              Last run {RUN_STATUS_LABEL[workflow.lastRun.status]?.toLowerCase()}
            </span>
          )}
          {workflow.currentVersion !== null && (
            <span className="hidden text-xs text-zinc-400 sm:inline">
              v{workflow.currentVersion}
            </span>
          )}
          <Badge tone={runStatusTone(workflow.status === 'active' ? 'running' : workflow.status)}>
            {WORKFLOW_STATUS_LABEL[workflow.status]}
          </Badge>
          <ChevronRight className="size-4 text-zinc-300" strokeWidth={1.75} />
        </div>
      </Link>
    </li>
  )
}

function CreateWorkflowModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    const result = await createWorkflowShell({
      data: { name, ...(description ? { description } : {}) },
    })
    if (!result.ok) {
      setError('Something went wrong. Try again.')
      setBusy(false)
      return
    }
    await router.invalidate()
    router.navigate({ to: '/workflows/$workflowId', params: { workflowId: result.id } })
  }

  return (
    <Modal title="New workflow" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="wf-name">
          <input
            id="wf-name"
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Review existing strategy"
          />
        </Field>
        <Field label="What is it for?" htmlFor="wf-purpose" hint="Optional.">
          <input
            id="wf-purpose"
            className={inputClass}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="A strategist drafts, a critic reviews."
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !name.trim()} onClick={submit}>
            Create workflow
          </Button>
        </div>
        <p className="text-xs text-zinc-400">You will add the steps on the next screen.</p>
      </div>
    </Modal>
  )
}
