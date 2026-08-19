import { ArrowDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'

import { OPERATOR_LABEL, STEP_TYPE_LABEL } from './labels'
import type { AgentOption, EntityOption, ToolOption } from './server'

/**
 * The non-technical workflow editor. Users build an ordered step list with
 * dropdowns and text fields; raw JSON is never shown or edited. The client
 * assembles plain definition DATA which the server validates before saving
 * as a new immutable version.
 */

/* ---- client-side editor model ---- */

export interface EditorInput {
  key: string
  label: string
  kind: 'text' | 'brand' | 'niche' | 'product' | 'account' | 'campaign'
  required: boolean
}

export interface EditorBinding {
  key: string
  source: 'workflow_input' | 'step_output' | 'literal'
  /** workflow_input / step_output path. */
  path: string
  /** step_output only. */
  stepId: string
  /** literal only. */
  value: string
}

export interface EditorStep {
  id: string
  type: 'agent' | 'tool' | 'condition' | 'end'
  agentId: string
  versionPolicy: 'current_at_run' | 'pinned'
  agentVersionId: string
  task: string
  toolKey: string
  requestedById: string
  inputs: EditorBinding[]
  /** '' = end of workflow. */
  next: string
  conditionSource: 'workflow_input' | 'step_output' | 'literal'
  conditionPath: string
  conditionStepId: string
  conditionLiteral: string
  operator: string
  compareValue: string
  yes: string
  no: string
}

export interface EditorState {
  inputs: EditorInput[]
  steps: EditorStep[]
  outputStepId: string
  outputPath: string
}

const OPERATORS = Object.keys(OPERATOR_LABEL)

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

function blankStep(type: EditorStep['type'], agents: AgentOption[]): EditorStep {
  const firstActive = agents.find((a) => a.status === 'active')
  return {
    id: nextId(type === 'condition' ? 'decide' : type),
    type,
    agentId: firstActive?.id ?? '',
    versionPolicy: 'current_at_run',
    agentVersionId: '',
    task: '',
    toolKey: '',
    requestedById: firstActive?.id ?? '',
    inputs: [],
    next: '',
    conditionSource: 'step_output',
    conditionPath: 'content',
    conditionStepId: '',
    conditionLiteral: '',
    operator: 'exists',
    compareValue: '',
    yes: '',
    no: '',
  }
}

/** Raw step shape as stored in a definition (parsed JSON, typed loosely). */
interface RawStep {
  id?: unknown
  type?: unknown
  agent?: { agentId: string; versionPolicy: string; agentVersionId?: string }
  requestedBy?: { agentId: string; versionPolicy: string; agentVersionId?: string }
  task?: unknown
  toolKey?: unknown
  inputs?: unknown
  next?: unknown
  condition?: {
    left: { source: string; path?: string; stepId?: string; value?: unknown }
    operator: string
    value?: unknown
  }
  branches?: { yes: string | null; no: string | null }
}

/** Server definition → editor state. */
export function editorStateFrom(definition: unknown): EditorState {
  const def = definition as {
    inputs?: { key: string; label: string; kind: EditorInput['kind']; required: boolean }[]
    steps?: RawStep[]
    output?: { stepId: string; path?: string }
  }
  const steps: EditorStep[] = (def.steps ?? []).map((raw) => {
    const rawType = raw.type as EditorStep['type']
    const base = blankStep(rawType ?? 'agent', [])
    const step: EditorStep = {
      ...base,
      id: String(raw.id ?? base.id),
      type: rawType,
    }
    if (rawType === 'agent' && raw.agent) {
      step.agentId = raw.agent.agentId
      step.versionPolicy = raw.agent.versionPolicy === 'pinned' ? 'pinned' : 'current_at_run'
      step.agentVersionId = raw.agent.agentVersionId ?? ''
      step.task = String(raw.task ?? '')
      step.inputs = bindingsFrom(raw.inputs)
    }
    if (rawType === 'tool' && raw.requestedBy) {
      step.toolKey = String(raw.toolKey ?? '')
      step.requestedById = raw.requestedBy.agentId
      step.versionPolicy = raw.requestedBy.versionPolicy === 'pinned' ? 'pinned' : 'current_at_run'
      step.agentVersionId = raw.requestedBy.agentVersionId ?? ''
      step.inputs = bindingsFrom(raw.inputs)
    }
    if (rawType === 'condition' && raw.condition) {
      const condition = raw.condition
      step.conditionSource = (condition.left.source as EditorStep['conditionSource']) ?? 'literal'
      step.conditionPath = condition.left.path ?? ''
      step.conditionStepId = condition.left.stepId ?? ''
      step.conditionLiteral =
        condition.left.source === 'literal' ? String(condition.left.value ?? '') : ''
      step.operator = condition.operator
      step.compareValue = condition.value === undefined ? '' : String(condition.value)
      step.yes = raw.branches?.yes ?? ''
      step.no = raw.branches?.no ?? ''
    }
    if (rawType !== 'condition' && rawType !== 'end') {
      step.next = (raw.next as string | null) ?? ''
    }
    return step
  })
  return {
    inputs: (def.inputs ?? []).map((input) => ({
      key: input.key,
      label: input.label,
      kind: input.kind,
      required: input.required,
    })),
    steps,
    outputStepId: def.output?.stepId ?? '',
    outputPath: def.output?.path ?? '',
  }
}

function bindingsFrom(raw: unknown): EditorBinding[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    const binding = item as {
      key: string
      value: { source: string; path?: string; stepId?: string; value?: unknown }
    }
    return {
      key: binding.key,
      source: (binding.value.source as EditorBinding['source']) ?? 'literal',
      path: binding.value.path ?? '',
      stepId: binding.value.stepId ?? '',
      value: binding.value.source === 'literal' ? String(binding.value.value ?? '') : '',
    }
  })
}

/** Editor state → plain definition data (validated server-side). */
export function definitionFromEditor(state: EditorState): unknown {
  const steps = state.steps.map((step) => {
    if (step.type === 'end') return { id: step.id, type: 'end' }
    if (step.type === 'condition') {
      const left =
        step.conditionSource === 'literal'
          ? { source: 'literal', value: parseLiteral(step.conditionLiteral) }
          : step.conditionSource === 'workflow_input'
            ? { source: 'workflow_input', path: step.conditionPath }
            : { source: 'step_output', stepId: step.conditionStepId, path: step.conditionPath }
      const needsValue = !['exists', 'not_exists'].includes(step.operator)
      return {
        id: step.id,
        type: 'condition',
        condition: {
          left,
          operator: step.operator,
          ...(needsValue ? { value: parseLiteral(step.compareValue) } : {}),
        },
        branches: { yes: step.yes || null, no: step.no || null },
      }
    }
    const bindings = step.inputs.map((binding) => ({
      key: binding.key,
      value:
        binding.source === 'literal'
          ? { source: 'literal', value: parseLiteral(binding.value) }
          : binding.source === 'workflow_input'
            ? { source: 'workflow_input', path: binding.path }
            : { source: 'step_output', stepId: binding.stepId, path: binding.path },
    }))
    const agentRef =
      step.versionPolicy === 'pinned' && step.agentVersionId
        ? { agentId: step.agentId, versionPolicy: 'pinned', agentVersionId: step.agentVersionId }
        : { agentId: step.agentId, versionPolicy: 'current_at_run' }
    if (step.type === 'agent') {
      return {
        id: step.id,
        type: 'agent',
        agent: agentRef,
        task: step.task,
        inputs: bindings,
        next: step.next || null,
      }
    }
    return {
      id: step.id,
      type: 'tool',
      toolKey: step.toolKey,
      requestedBy: {
        ...agentRef,
        agentId: step.requestedById,
      },
      inputs: bindings,
      next: step.next || null,
    }
  })
  return {
    entryStepId: state.steps[0]?.id ?? '',
    inputs: state.inputs.map((input) => ({
      key: input.key,
      label: input.label,
      kind: input.kind,
      required: input.required,
    })),
    steps,
    ...(state.outputStepId
      ? {
          output: {
            stepId: state.outputStepId,
            ...(state.outputPath ? { path: state.outputPath } : {}),
          },
        }
      : {}),
  }
}

function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  return trimmed
}

/* ---- the editor component ---- */

interface WorkflowEditorProps {
  initial: EditorState
  agents: AgentOption[]
  tools: ToolOption[]
  saving: boolean
  errors: string[]
  warnings: string[]
  onSave: (definition: unknown) => void
  onCancel: () => void
}

export function WorkflowEditor({
  initial,
  agents,
  tools,
  saving,
  errors,
  warnings,
  onSave,
  onCancel,
}: WorkflowEditorProps) {
  const [state, setState] = useState<EditorState>(initial)

  const update = (mutate: (draft: EditorState) => void) => {
    setState((current) => {
      const draft: EditorState = {
        inputs: current.inputs.map((input) => ({ ...input })),
        steps: current.steps.map((step) => ({
          ...step,
          inputs: step.inputs.map((b) => ({ ...b })),
        })),
        outputStepId: current.outputStepId,
        outputPath: current.outputPath,
      }
      mutate(draft)
      return draft
    })
  }

  const stepOptions = state.steps.map((step) => ({ id: step.id, label: step.id }))

  return (
    <div className="flex flex-col gap-5 rounded-md border border-zinc-200 bg-white p-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
          What this workflow needs
        </h3>
        <p className="text-xs text-zinc-500">
          Inputs are chosen each time the workflow runs, like the product to look at.
        </p>
        {state.inputs.map((input, index) => (
          <div key={input.key || index} className="flex items-end gap-2">
            <Field label="Name">
              <input
                className={inputClass}
                value={input.label}
                onChange={(e) =>
                  update((d) => {
                    const target = d.inputs[index]
                    if (target) {
                      target.label = e.target.value
                      target.key = slugify(e.target.value)
                    }
                  })
                }
                placeholder="Product"
              />
            </Field>
            <Field label="Kind">
              <select
                className={inputClass}
                value={input.kind}
                onChange={(e) =>
                  update((d) => {
                    const target = d.inputs[index]
                    if (target) target.kind = e.target.value as EditorInput['kind']
                  })
                }
              >
                <option value="product">Product</option>
                <option value="brand">Brand</option>
                <option value="account">Account</option>
                <option value="niche">Niche</option>
                <option value="campaign">Campaign</option>
                <option value="text">Short text</option>
              </select>
            </Field>
            <label className="flex items-center gap-1 pb-2 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={input.required}
                onChange={(e) =>
                  update((d) => {
                    const target = d.inputs[index]
                    if (target) target.required = e.target.checked
                  })
                }
              />
              Required
            </label>
            <Button
              variant="secondary"
              onClick={() => update((d) => void d.inputs.splice(index, 1))}
            >
              <Trash2 className="size-4" strokeWidth={1.75} />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              update((d) =>
                d.inputs.push({
                  key: nextId('input').replaceAll('-', '_'),
                  label: '',
                  kind: 'product',
                  required: true,
                }),
              )
            }
          >
            <Plus className="size-4" strokeWidth={1.75} />
            Add input
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Steps</h3>
        {state.steps.length === 0 && (
          <p className="text-xs text-zinc-400">No steps yet. Add the first step below.</p>
        )}
        {state.steps.map((step, index) => (
          <StepEditor
            key={step.id}
            step={step}
            index={index}
            agents={agents}
            tools={tools}
            stepOptions={stepOptions}
            inputs={state.inputs}
            steps={state.steps}
            onChange={(next) =>
              update((d) => {
                d.steps[index] = next
              })
            }
            onRemove={() => update((d) => void d.steps.splice(index, 1))}
          />
        ))}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => update((d) => d.steps.push(blankStep('agent', agents)))}
          >
            <Plus className="size-4" strokeWidth={1.75} />
            Agent step
          </Button>
          <Button
            variant="secondary"
            onClick={() => update((d) => d.steps.push(blankStep('tool', agents)))}
          >
            <Plus className="size-4" strokeWidth={1.75} />
            Tool step
          </Button>
          <Button
            variant="secondary"
            onClick={() => update((d) => d.steps.push(blankStep('condition', agents)))}
          >
            <Plus className="size-4" strokeWidth={1.75} />
            Decision
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Result</h3>
        <div className="flex items-end gap-2">
          <Field label="The result comes from step" hint="Optional.">
            <select
              className={inputClass}
              value={state.outputStepId}
              onChange={(e) =>
                update((d) => {
                  d.outputStepId = e.target.value
                })
              }
            >
              <option value="">No explicit result</option>
              {stepOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Part" hint='e.g. "content" for an agent answer.'>
            <input
              className={inputClass}
              value={state.outputPath}
              onChange={(e) =>
                update((d) => {
                  d.outputPath = e.target.value
                })
              }
              placeholder="content"
            />
          </Field>
        </div>
      </section>

      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <p
              key={warning}
              className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700"
            >
              {warning}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {errors.map((error) => (
          <FormError key={error} message={error} />
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={saving || state.steps.length === 0}
          onClick={() => onSave(definitionFromEditor(state))}
        >
          {saving ? 'Saving…' : 'Save as new version'}
        </Button>
      </div>
    </div>
  )
}

/* ---- single step ---- */

interface StepEditorProps {
  step: EditorStep
  index: number
  agents: AgentOption[]
  tools: ToolOption[]
  stepOptions: { id: string; label: string }[]
  inputs: EditorInput[]
  steps: EditorStep[]
  onChange: (step: EditorStep) => void
  onRemove: () => void
}

function StepEditor({
  step,
  index,
  agents,
  tools,
  stepOptions,
  inputs,
  steps,
  onChange,
  onRemove,
}: StepEditorProps) {
  const set = (patch: Partial<EditorStep>) => onChange({ ...step, ...patch })
  const activeAgents = agents.filter((agent) => agent.status === 'active')
  const selectedAgent = agents.find((agent) => agent.id === step.agentId)
  const selectedRequester = agents.find((agent) => agent.id === step.requestedById)

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-100 bg-zinc-50/60 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-400">{index + 1}.</span>
          <Badge tone="neutral">{STEP_TYPE_LABEL[step.type]}</Badge>
          <input
            className="w-40 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-600 focus:border-zinc-300 focus:bg-white focus:outline-none"
            value={step.id}
            onChange={(e) => set({ id: e.target.value })}
            aria-label="Step name"
            title="Step name (used for passing results between steps)"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          aria-label="Remove step"
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {step.type === 'agent' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Agent">
              <select
                className={inputClass}
                value={step.agentId}
                onChange={(e) => set({ agentId: e.target.value, agentVersionId: '' })}
              >
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Version" hint="“Current when run” follows improvements automatically.">
              <select
                className={inputClass}
                value={step.versionPolicy === 'pinned' ? step.agentVersionId : 'current'}
                onChange={(e) => {
                  if (e.target.value === 'current') {
                    set({ versionPolicy: 'current_at_run', agentVersionId: '' })
                  } else {
                    set({ versionPolicy: 'pinned', agentVersionId: e.target.value })
                  }
                }}
              >
                <option value="current">Current when run</option>
                {(selectedAgent?.versions ?? []).map((version) => (
                  <option key={version.id} value={version.id}>
                    Always v{version.version}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Task" hint="What this agent should do in this step.">
            <textarea
              className={inputClass}
              rows={2}
              value={step.task}
              onChange={(e) => set({ task: e.target.value })}
              placeholder="Review the available context and draft a positioning."
            />
          </Field>
        </>
      )}

      {step.type === 'tool' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Tool">
            <select
              className={inputClass}
              value={step.toolKey}
              onChange={(e) => set({ toolKey: e.target.value })}
            >
              <option value="">Choose a tool…</option>
              {tools.map((tool) => (
                <option key={tool.key} value={tool.key}>
                  {tool.name}
                  {tool.status !== 'available' ? ' (not available)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Requested by" hint="The agent whose permissions apply.">
            <select
              className={inputClass}
              value={step.requestedById}
              onChange={(e) => set({ requestedById: e.target.value, agentVersionId: '' })}
            >
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          {step.versionPolicy === 'pinned' && selectedRequester && (
            <Field label="Version">
              <select
                className={inputClass}
                value={step.agentVersionId}
                onChange={(e) => set({ agentVersionId: e.target.value })}
              >
                <option value="">Current when run</option>
                {selectedRequester.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    Always v{version.version}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}

      {step.type === 'condition' && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Check">
              <select
                className={inputClass}
                value={step.conditionSource}
                onChange={(e) =>
                  set({ conditionSource: e.target.value as EditorStep['conditionSource'] })
                }
              >
                <option value="step_output">A step result</option>
                <option value="workflow_input">A workflow input</option>
                <option value="literal">A fixed value</option>
              </select>
            </Field>
            {step.conditionSource === 'step_output' && (
              <Field label="From step">
                <select
                  className={inputClass}
                  value={step.conditionStepId}
                  onChange={(e) => set({ conditionStepId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {stepOptions
                    .filter((option) => option.id !== step.id)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            {step.conditionSource === 'workflow_input' && (
              <Field label="Input">
                <select
                  className={inputClass}
                  value={step.conditionPath}
                  onChange={(e) => set({ conditionPath: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {inputs.map((input) => (
                    <option key={input.key} value={input.key}>
                      {input.label || input.key}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {step.conditionSource === 'literal' && (
              <Field label="Value">
                <input
                  className={inputClass}
                  value={step.conditionLiteral}
                  onChange={(e) => set({ conditionLiteral: e.target.value })}
                />
              </Field>
            )}
            {step.conditionSource === 'step_output' && (
              <Field label="Part" hint='e.g. "content" or "data.count".'>
                <input
                  className={inputClass}
                  value={step.conditionPath}
                  onChange={(e) => set({ conditionPath: e.target.value })}
                />
              </Field>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Operator">
              <select
                className={inputClass}
                value={step.operator}
                onChange={(e) => set({ operator: e.target.value })}
              >
                {OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABEL[operator]}
                  </option>
                ))}
              </select>
            </Field>
            {!['exists', 'not_exists'].includes(step.operator) && (
              <Field label="Compare to">
                <input
                  className={inputClass}
                  value={step.compareValue}
                  onChange={(e) => set({ compareValue: e.target.value })}
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="If yes go to">
                <StepTargetSelect
                  value={step.yes}
                  options={stepOptions}
                  exclude={step.id}
                  onChange={(value) => set({ yes: value })}
                />
              </Field>
              <Field label="If no go to">
                <StepTargetSelect
                  value={step.no}
                  options={stepOptions}
                  exclude={step.id}
                  onChange={(value) => set({ no: value })}
                />
              </Field>
            </div>
          </div>
        </>
      )}

      {(step.type === 'agent' || step.type === 'tool') && (
        <BindingEditor step={step} steps={steps} inputs={inputs} onChange={onChange} />
      )}

      {step.type !== 'condition' && step.type !== 'end' && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <ArrowDown className="size-3.5" strokeWidth={1.75} />
          <span>Then go to</span>
          <div className="w-48">
            <StepTargetSelect
              value={step.next}
              options={stepOptions}
              exclude={step.id}
              onChange={(value) => set({ next: value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function StepTargetSelect({
  value,
  options,
  exclude,
  onChange,
}: {
  value: string
  options: { id: string; label: string }[]
  exclude?: string
  onChange: (value: string) => void
}) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">End of workflow</option>
      {options
        .filter((option) => option.id !== exclude)
        .map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
    </select>
  )
}

/* ---- bindings ---- */

function BindingEditor({
  step,
  steps,
  inputs,
  onChange,
}: {
  step: EditorStep
  steps: EditorStep[]
  inputs: EditorInput[]
  onChange: (step: EditorStep) => void
}) {
  const setBinding = (index: number, patch: Partial<EditorBinding>) => {
    const nextBindings = step.inputs.map((binding, i) =>
      i === index ? { ...binding, ...patch } : binding,
    )
    onChange({ ...step, inputs: nextBindings })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-zinc-500">
        Values passed in <span className="font-normal text-zinc-400">(optional)</span>
      </p>
      {step.inputs.map((binding, index) => (
        <div key={binding.key || index} className="flex items-end gap-2">
          <Field label="Call it">
            <input
              className={inputClass}
              value={binding.key}
              onChange={(e) => setBinding(index, { key: e.target.value })}
              placeholder="research"
            />
          </Field>
          <Field label="From">
            <select
              className={inputClass}
              value={binding.source}
              onChange={(e) =>
                setBinding(index, { source: e.target.value as EditorBinding['source'] })
              }
            >
              <option value="step_output">A step result</option>
              <option value="workflow_input">A workflow input</option>
              <option value="literal">A fixed value</option>
            </select>
          </Field>
          {binding.source === 'step_output' && (
            <>
              <Field label="Step">
                <select
                  className={inputClass}
                  value={binding.stepId}
                  onChange={(e) => setBinding(index, { stepId: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {steps
                    .filter((candidate) => candidate.id !== step.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.id}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Part">
                <input
                  className={inputClass}
                  value={binding.path}
                  onChange={(e) => setBinding(index, { path: e.target.value })}
                  placeholder="content"
                />
              </Field>
            </>
          )}
          {binding.source === 'workflow_input' && (
            <Field label="Input">
              <select
                className={inputClass}
                value={binding.path}
                onChange={(e) => setBinding(index, { path: e.target.value })}
              >
                <option value="">Choose…</option>
                {inputs.map((input) => (
                  <option key={input.key} value={input.key}>
                    {input.label || input.key}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {binding.source === 'literal' && (
            <Field label="Value">
              <input
                className={inputClass}
                value={binding.value}
                onChange={(e) => setBinding(index, { value: e.target.value })}
              />
            </Field>
          )}
          <Button
            variant="secondary"
            onClick={() => onChange({ ...step, inputs: step.inputs.filter((_, i) => i !== index) })}
          >
            <Trash2 className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            onChange({
              ...step,
              inputs: [
                ...step.inputs,
                { key: '', source: 'step_output', path: 'content', stepId: '', value: '' },
              ],
            })
          }
        >
          <Plus className="size-4" strokeWidth={1.75} />
          Pass a value in
        </Button>
      </div>
    </div>
  )
}

function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'input'
  )
}

/* Re-exported for the run dialog. */
export type { EntityOption }
