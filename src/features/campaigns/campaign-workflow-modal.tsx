import { AlertCircle, CheckCircle2, Loader2, Play } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'
import type { CampaignDetail } from '~/server/db/campaign'
import type { WorkflowInputDecl } from '~/server/workflows/definition'
import { getWorkflowInputDeclsFn, startCampaignWorkflowRunFn } from './server'

interface CampaignWorkflowModalProps {
  campaign: CampaignDetail
  activeWorkflows: Array<{ id: string; name: string; description: string | null }>
  onClose: () => void
  onSuccess: (runId?: string) => Promise<void> | void
}

export function CampaignWorkflowModal({
  campaign,
  activeWorkflows,
  onClose,
  onSuccess,
}: CampaignWorkflowModalProps) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(activeWorkflows[0]?.id ?? '')
  const [inputDecls, setInputDecls] = useState<WorkflowInputDecl[]>([])
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [loadingInputs, setLoadingInputs] = useState<boolean>(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!selectedWorkflowId) {
      setInputDecls([])
      setInputValues({})
      return
    }

    let isCancelled = false
    setLoadingInputs(true)
    setFormError(null)

    getWorkflowInputDeclsFn({ data: { workflowId: selectedWorkflowId } })
      .then((decls) => {
        if (isCancelled) return
        setInputDecls(decls)
        const initial: Record<string, string> = {}
        for (const d of decls) {
          if (d.kind === 'campaign') {
            initial[d.key] = campaign.id
          } else {
            initial[d.key] = ''
          }
        }
        setInputValues(initial)
      })
      .catch((err) => {
        if (isCancelled) return
        setFormError(err instanceof Error ? err.message : 'Failed to load workflow inputs.')
      })
      .finally(() => {
        if (!isCancelled) setLoadingInputs(false)
      })

    return () => {
      isCancelled = true
    }
  }, [selectedWorkflowId, campaign.id])

  const handleInputChange = (key: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedWorkflowId) {
      setFormError('Please select a workflow to run.')
      return
    }

    // Client validation for required inputs
    for (const decl of inputDecls) {
      if (decl.required && decl.kind !== 'campaign') {
        const val = inputValues[decl.key]?.trim()
        if (!val) {
          setFormError(`"${decl.label}" is required.`)
          return
        }
      }
    }

    setFormError(null)
    startTransition(async () => {
      try {
        const formattedInputs: Record<string, unknown> = {}
        for (const decl of inputDecls) {
          if (decl.kind === 'campaign') {
            formattedInputs[decl.key] = campaign.id
          } else {
            const v = inputValues[decl.key]
            if (v !== undefined && v !== '') {
              formattedInputs[decl.key] = v
            }
          }
        }

        const result = await startCampaignWorkflowRunFn({
          data: {
            campaignId: campaign.id,
            workflowId: selectedWorkflowId,
            inputs: formattedInputs,
          },
        })

        if (!result.ok) {
          setFormError(result.message ?? 'Failed to start workflow run.')
          return
        }

        await onSuccess(result.runId)
        onClose()
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'Failed to start workflow run.')
      }
    })
  }

  const selectedWorkflow = activeWorkflows.find((w) => w.id === selectedWorkflowId)

  return (
    <Modal title="Run Workflow on Campaign" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {formError && <FormError message={formError} />}

        {activeWorkflows.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertCircle className="size-4 text-amber-600" />
              No Active Workflows
            </div>
            <p>
              There are no active workflows available in this workspace. Create and activate a
              workflow in the Workflows section first.
            </p>
          </div>
        ) : (
          <>
            <Field label="Select Active Workflow">
              <select
                value={selectedWorkflowId}
                onChange={(e) => setSelectedWorkflowId(e.target.value)}
                className={inputClass}
                disabled={isPending}
              >
                {activeWorkflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>

            {selectedWorkflow?.description && (
              <p className="text-xs text-zinc-500 italic bg-zinc-50 p-2.5 rounded border border-zinc-100">
                {selectedWorkflow.description}
              </p>
            )}

            {/* Scope info indicator */}
            <div className="rounded border border-blue-100 bg-blue-50/50 p-3 text-xs text-blue-900 space-y-1">
              <div className="font-medium flex items-center gap-1.5 text-blue-800">
                <CheckCircle2 className="size-3.5 text-blue-600" />
                Campaign Execution Scope
              </div>
              <p className="text-[11px] text-blue-700">
                This workflow will execute within <strong>{campaign.name}</strong>. The Context
                Engine will automatically inject the campaign's strategic objective, audience,
                positioning, targets, content plan, and brand context into all agent steps.
              </p>
            </div>

            {/* Dynamic Inputs */}
            {loadingInputs ? (
              <div className="flex items-center justify-center py-4 text-xs text-zinc-500 gap-2">
                <Loader2 className="size-4 animate-spin" />
                Loading workflow parameters...
              </div>
            ) : (
              inputDecls.length > 0 && (
                <div className="space-y-3 border-t border-zinc-100 pt-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Workflow Inputs
                  </h4>
                  {inputDecls.map((decl) => {
                    if (decl.kind === 'campaign') {
                      return (
                        <div key={decl.key} className="space-y-1">
                          <span className="block text-xs font-medium text-zinc-700">
                            {decl.label}
                          </span>
                          <div className="rounded border border-zinc-200 bg-zinc-100 px-3 py-1.5 text-xs text-zinc-600 font-mono">
                            {campaign.name} ({campaign.id.slice(0, 8)}...)
                          </div>
                          <p className="text-[10px] text-zinc-400">
                            Bound automatically to this campaign.
                          </p>
                        </div>
                      )
                    }

                    return (
                      <Field key={decl.key} label={`${decl.label}${decl.required ? ' *' : ''}`}>
                        <input
                          type="text"
                          value={inputValues[decl.key] ?? ''}
                          onChange={(e) => handleInputChange(decl.key, e.target.value)}
                          className={inputClass}
                          placeholder={`Enter ${decl.label.toLowerCase()}`}
                          disabled={isPending}
                        />
                      </Field>
                    )
                  })}
                </div>
              )
            )}
          </>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          {activeWorkflows.length > 0 && (
            <Button type="submit" disabled={isPending || loadingInputs}>
              {isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin mr-1.5" />
                  Starting Run...
                </>
              ) : (
                <>
                  <Play className="size-3.5 mr-1.5" />
                  Start Workflow Run
                </>
              )}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  )
}
