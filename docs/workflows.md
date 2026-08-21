# Workflow Engine (STEP 10)

Declarative, versioned, resumable multi-step processes that invoke agents
and tools in a defined order.

```
Workflow (stable identity)
  → Workflow Version (immutable definition snapshot)
    → Workflow Run (one execution, persisted + resumable)
      → Step Runs (agent / tool / condition / end)
```

The five concepts stay separate: an **Agent** is WHO works, a **Tool** is
WHAT controlled capability is used, a **Workflow** is IN WHAT ORDER, an
**Approval** (STEP 11) is WHETHER a sensitive action may proceed, and a
**Platform Adapter** is HOW a platform operation is implemented. The engine
never collapses them.

## Definitions are data, never code

`src/server/workflows/definition.ts` is the ONE format: a zod-validated
JSON document stored in `workflow_version.definition`. There is no eval, no
expression language, no template engine. Steps reference registered agents
and tools by identity; values flow through typed bindings.

```jsonc
{
  "entryStepId": "draft",
  "inputs": [
    { "key": "product_id", "label": "Product", "kind": "product", "required": true }
  ],
  "steps": [
    {
      "id": "draft",
      "type": "agent",
      "agent": { "agentId": "…", "versionPolicy": "current_at_run" },
      "task": "Analyze the available context.",
      "inputs": [
        { "key": "focus", "value": { "source": "workflow_input", "path": "focus" } }
      ],
      "next": "review"
    },
    {
      "id": "review",
      "type": "agent",
      "agent": { "agentId": "…", "versionPolicy": "current_at_run" },
      "task": "Critique the analysis.",
      "inputs": [
        { "key": "analysis", "value": { "source": "step_output", "stepId": "draft", "path": "content" } }
      ],
      "next": null
    }
  ],
  "output": { "stepId": "review", "path": "content" }
}
```

## Step types

- **agent** — runs a registered agent version through the generic
  `executeAgentTask` (src/server/agents/task.ts). The step supplies the
  *task*; the agent version supplies identity/instructions; the Context
  Engine snapshot supplies workspace context. Never writes chat messages.
- **tool** — runs a registered tool through `executeTool` ONLY, with
  `requestedBy` (a resolved agent version) as the caller. Capability,
  availability and approval checks all still apply; a workflow is never a
  super-user.
- **condition** — deterministic branching over structured data with a fixed
  operator set (`equals`, `not_equals`, `exists`, `not_exists`,
  `greater_than`, `greater_or_equal`, `less_than`, `less_or_equal`). No AI
  call just to branch.
- **end** — explicit terminal. `next: null` on any step also terminates.

## Versioning

Same doctrine as agents: `workflow` is a mutable shell with
`current_version_id`; `workflow_version` rows are immutable
(`UNIQUE(workflow_id, version)`). Editing saves vN+1; old versions are
never mutated, so every run re-reads the exact definition it executed.
Rollback = new version copied from an old one. Statuses live on the shell:
`draft` / `active` / `disabled` / `archived`; only `active` runs.

## Agent version resolution

- `current_at_run` — resolved ONCE at run start, frozen into the run plan
  (`workflow_run.plan_json`). If the agent ships a new version mid-run, the
  run keeps the version it resolved.
- `pinned` — the definition names an exact `agent_version_id`.

Retries and resumes never re-resolve versions. Agent *status* is re-checked
at every step execution: an agent disabled mid-run fails the step safely.

## Bindings

Typed value references, resolved by the engine (`bindings.ts`):

- `{ source: 'workflow_input', path: 'product_id' }`
- `{ source: 'step_output', stepId: 'draft', path: 'content' }`
- `{ source: 'literal', value: … }`
- `{ source: 'run', path: 'runId' | 'workflowId' | 'workflowVersionId' }`

Paths are dotted keys walked over plain JSON (`__proto__`/`constructor`
blocked). A missing path resolves to absent, never an exception.

## Branching and bounded loops

Condition steps pick `branches.yes` / `branches.no` (null = terminate); the
choice is persisted on the step run (`decision`). Cycles are allowed but
MUST be bounded: every step has an effective visit cap (per-step
`maxVisits`, else the run limit `maxVisitsPerStep`, default 5). Validation
rejects a cycle containing a step that explicitly requests no cap, and
rejects workflows with no terminating path.

## Limits

All bounds live in `src/server/workflows/limits.ts`: definition size/step
count/task length/binding count, run-level step executions (50), visits per
step (5), agent/tool executions (20), run duration (5 min), snapshot sizes.
Definition-level `limits` may only tighten the globals; the resolved limits
are frozen into the run plan.

## Validation

`validate.ts` runs before a version is saved as current and defensively at
run start: entry step exists, ids unique, targets exist, agents exist and
aren't archived (disabled = warning at save, rejection at run), pinned
versions belong to their agent, tool keys are registered, bindings
reference declared inputs/existing steps, condition operators are valid,
cycles are bounded, a terminating path exists. Unreachable steps warn.

## Runs & Exact Scope Integrity (H3B.2)

`startWorkflowRun` (engine.ts):

1. Workflow must be active in this workspace
2. Definition re-validated
3. Inputs validated against declaration BEFORE execution starts
4. Exact scope (`scope_type`, `scope_id`) resolved from explicit caller parameters or extracted from primary entity inputs (campaign, brand, niche, product, account)
5. Entity-kind inputs become explicit Context Engine references — scope conflicts, cross-workspace ids and archived entities reject here
6. A safe ContextPackage snapshot is persisted (`context_json`)
7. Agent versions are frozen (`plan_json`)
8. The run row is persisted (`running`) with exact `scope_type` and `scope_id` columns, indexed by `idx_workflow_run_scope(workspace_id, scope_type, scope_id)`
9. `driveRun` drives the step execution

### Scope Querying & Isolation
- Campaign orchestration writes exact `scope_type = 'campaign'`, `scope_id = campaign.id`.
- `listCampaignWorkflowRuns` performs exact indexed queries (`scope_type = 'campaign' AND scope_id = ?`) rather than fragile JSON string scans.
- Historical runs maintain structured `activeScope` in `plan_json` for backward compatibility.

`driveRun` persists state after EVERY transition (`state_json`: next step,
visit counts, counters), so a run never depends on one request staying
alive. `resumeWorkflowRun` continues queued/running/waiting runs from the
persisted state; completed steps never re-execute, and a step left
`running` by an interruption is recorded as failed and re-attempted.
`cancelWorkflowRun` stops pending/active runs; history is kept.

Run statuses: `queued` / `running` / `waiting` / `succeeded` / `failed` /
`cancelled`. Step runs additionally have `skipped`. `waiting` is the
approval-compatible pause: when `executeTool` returns `approval_required`
the step run goes `waiting` and the run pauses — neither failure nor
success. On human approval, `resumeWorkflowRun` is called with an authorized
approval token to continue execution safely without re-entry loops.

## Retries and failures

Bounded and classified. Agent steps retry only retryable AI errors
(provider_unavailable / rate_limited / network) up to `retry.maxAttempts`
(≤3, default 1 = no retry). Tool steps retry only `timeout`. Invalid input,
capability denied, disabled agents and unavailable tools never retry. A
failed step fails the run unless the step declares
`onFailure: { action: 'goto', stepId }`.

## Idempotency

Run ids and step-run `(run, step, attempt)` identities are stable. Tool
steps pass `idempotencyKey = runId:stepId:attempt` into `executeTool`, so
future write tools can deduplicate; a retried attempt gets a new key, a
replayed one never does.

## Events

Emitted on the existing `event` table (actor `workflow`):
`workflow.created`, `workflow.version_created`, `workflow.run_started`,
`workflow.step_started`, `workflow.step_completed`, `workflow.step_failed`,
`workflow.run_completed`, `workflow.run_failed`, `workflow.run_cancelled`.
Payloads carry ids, labels and counts only — never secrets.

## Runtime adapter

Two layers (`runtime.ts`): the **Workflow Engine** owns domain semantics;
the **WorkflowRuntime** owns how `driveRun` is scheduled. The inline
runtime (used by the UI and tests) drives the run in the current request.
Cloudflare Workflows is the intended durable runtime but its binding is NOT
configured here, so no live Cloudflare execution is claimed. To activate it
later: add a `workflows` binding to wrangler.jsonc, run
`npm run cf-typegen`, and implement a runtime that wraps `driveRun` in a
Workflow entrypoint. The engine does not change.

## UI

`/workflows` lists workflows (status, current version, last run).
`/workflows/$id` shows the step summary, version history, recent runs and
hosts the non-technical editor (step list, dropdowns, no JSON) and the run
dialog. `/workflows/$id/runs/$runId` shows step-by-step results; in dev
builds it also renders the full trace (inputs, outputs, decisions, plan,
context snapshot — never secrets).

## Not built yet (deliberately)

Chief workflow selection/creation, the Approval Center, scheduling,
automatic triggers, platform publishing, drag-and-drop editing.

Tests: `npm run test:workflows`.
