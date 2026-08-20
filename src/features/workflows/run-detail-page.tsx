import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { Ban, RotateCcw } from 'lucide-react'

import { PageHeader } from '~/components/layout/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { RUN_STATUS_LABEL, runStatusTone, STEP_STATUS_LABEL, STEP_TYPE_LABEL } from './labels.ts'

import { cancelWorkflowRunFn, resumeWorkflowAfterApprovalFn, resumeWorkflowRunFn } from './server'

const routeApi = getRouteApi('/workflows_/$workflowId_/runs/$runId')

export function RunDetailPage() {
  const router = useRouter()
  const data = routeApi.useLoaderData()
  const { run, workflow, version, scope, steps, devTrace } = data

  const active = run.status === 'running' || run.status === 'queued' || run.status === 'waiting'

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      <PageHeader
        title={`${workflow.name} — run`}
        description={
          scope ? `Ran on ${scope.label} with version ${version}.` : `Ran with version ${version}.`
        }
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={runStatusTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
            {active && (
              <Button
                variant="secondary"
                onClick={async () => {
                  await cancelWorkflowRunFn({ data: { runId: run.id } })
                  await router.invalidate()
                }}
              >
                <Ban className="size-4" strokeWidth={1.75} />
                Cancel
              </Button>
            )}
            {(run.status === 'waiting' || run.status === 'running') && (
              <Button
                variant="secondary"
                onClick={async () => {
                  await resumeWorkflowRunFn({ data: { runId: run.id } })
                  await router.invalidate()
                }}
              >
                <RotateCcw className="size-4" strokeWidth={1.75} />
                Resume
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
        <span>Started {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</span>
        <span>Finished {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}</span>
      </div>

      {run.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{run.error}</p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Steps</h2>
        {steps.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-200 px-4 py-4 text-xs text-zinc-400">
            No steps have run yet.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step) => (
              <li
                key={step.id}
                className="flex flex-col gap-1.5 rounded-md border border-zinc-200 bg-white px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <Badge tone={runStatusTone(step.status)}>
                    {STEP_STATUS_LABEL[step.status] ?? step.status}
                  </Badge>
                  <Badge tone="neutral">{STEP_TYPE_LABEL[step.stepType]}</Badge>
                  <span className="text-xs font-medium text-zinc-700">{step.stepKey}</span>
                  {step.agentName && (
                    <span className="text-xs text-zinc-500">by {step.agentName}</span>
                  )}
                  {step.toolKey && <span className="text-xs text-zinc-500">{step.toolKey}</span>}
                  {step.attempt > 1 && (
                    <span className="text-xs text-zinc-400">attempt {step.attempt}</span>
                  )}
                </div>
                {step.summary && <p className="text-xs text-zinc-600">{step.summary}</p>}
                {step.approval && (
                  <div className="flex flex-wrap items-center gap-2 rounded bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
                    <span className="font-medium text-zinc-700">Approval:</span>
                    <Badge
                      tone={
                        step.approval.status === 'approved'
                          ? 'success'
                          : step.approval.status === 'rejected' ||
                              step.approval.status === 'expired'
                            ? 'muted'
                            : 'warning'
                      }
                    >
                      {step.approval.status}
                    </Badge>
                    <span className="text-[11px] text-zinc-400">
                      ID: {step.approval.id.slice(0, 8)}…
                    </span>
                    <span className="text-[11px] text-zinc-400">
                      Fingerprint: {step.approval.fingerprint.slice(0, 12)}…
                    </span>
                    {step.approval.decisionNote && (
                      <span className="text-[11px] text-zinc-500 italic">
                        "{step.approval.decisionNote}"
                      </span>
                    )}
                    {step.status === 'waiting' && step.approval.status === 'approved' && (
                      <Button
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={async () => {
                          if (step.approval?.id) {
                            await resumeWorkflowAfterApprovalFn({
                              data: { approvalRequestId: step.approval.id },
                            })
                            await router.invalidate()
                          }
                        }}
                      >
                        Resume step
                      </Button>
                    )}
                  </div>
                )}
                {step.error && step.status === 'failed' && (
                  <p className="text-xs text-red-600">{step.error}</p>
                )}
                {import.meta.env.DEV && (step.input !== undefined || step.output !== undefined) && (
                  <details className="text-xs text-zinc-500">
                    <summary className="cursor-pointer text-zinc-400">Details</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-zinc-50 p-2 text-[11px]">
                      {JSON.stringify(
                        {
                          input: step.input ?? null,
                          output: step.output ?? null,
                          decision: step.decision ?? null,
                          approval: step.approval ?? null,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {run.output !== null && run.output !== undefined && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Result</h2>
          <div className="rounded-md border border-zinc-200 bg-white px-4 py-3">
            <RunOutput value={run.output} />
          </div>
        </section>
      )}

      {import.meta.env.DEV && devTrace !== null && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
            Developer trace
          </h2>
          <pre className="max-h-96 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-600">
            {JSON.stringify(devTrace, null, 2)}
          </pre>
        </section>
      )}

      <p className="text-xs text-zinc-400">
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className="underline underline-offset-2"
        >
          Back to {workflow.name}
        </Link>
      </p>
    </div>
  )
}

function RunOutput({ value }: { value: unknown }) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { kind?: unknown; content?: unknown }
    if (record.kind === 'agent' && typeof record.content === 'string') {
      return <p className="text-sm whitespace-pre-wrap text-zinc-700">{record.content}</p>
    }
  }
  if (typeof value === 'string') {
    return <p className="text-sm whitespace-pre-wrap text-zinc-700">{value}</p>
  }
  return (
    <pre className="max-h-64 overflow-auto text-[11px] text-zinc-600">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}
