# Approval Requests System (STEP 11B)

While STEP 11A answers:

> **"What is the policy?"**

STEP 11B answers:

> **"What exact action is waiting for approval?"**

The Approval Request system creates, stores, deduplicates, and manages human authorization for concrete proposed actions.

```text
Action Proposal (actionKey, payload, origin, scope)
  → Policy Resolver (STEP 11A)
    ├── AUTO → Execute immediately; create no Approval Request
    ├── BLOCKED → Denied; create no Approval Request
    └── REVIEW → Construct safe snapshot & fingerprint
          └── Dedup Check (existing pending with same fingerprint?)
                ├── Yes → Reuse existing pending Approval Request
                └── No  → Create pending Approval Request row
                            ├── Emit 'approval.requested'
                            └── Write audit_log
```

---

## 1. Canonical Lifecycle States

The request lifecycle uses five canonical statuses:

| Status | Meaning | Can Transition To |
|---|---|---|
| `pending` | Waiting for human decision | `approved`, `rejected`, `cancelled`, `expired` |
| `approved` | Authorized by human user | Terminal state (immutable) |
| `rejected` | Denied by human user | Terminal state (immutable) |
| `cancelled` | Cancelled by user or requester | Terminal state (immutable) |
| `expired` | Passed `expires_at` without decision | Terminal state (immutable) |

---

## 2. Immutable Safe Snapshots & Fingerprinting

Approval must approve the exact proposed action parameters.

### Secret Stripping
Action snapshots recursively strip secrets matching:
- `api_key`, `token`, `password`, `secret`, `bearer`, `authorization`, `credential`
- Raw credentials are never stored in D1 or emitted into events.

### Deterministic Fingerprint
1. Recursively sorts dictionary keys.
2. Canonical JSON serialized.
3. Computes SHA-256 hash: `SHA256(actionKey + ":" + canonicalSnapshotJson)`.
4. Stored as `fingerprint` (64-character hex string).

### Integrity Check on Decision
Before deciding a request (`decideApprovalRequest`), the engine recomputes the SHA-256 fingerprint from `snapshot_json` and validates it against the stored `fingerprint`. Any database tampering fails immediately.

---

## 3. Deduplication (Idempotent Creation)

If an agent or workflow issues the same action while an identical request is already pending:
- Identified by `(workspace_id, action_key, fingerprint, execution_id)` where `status = 'pending'`.
- Returns `{ isDuplicate: true, request: existingRequest }` instead of spamming duplicate approvals.

---

## 4. Anti-Self-Approval Security

Authorization is strictly external to AI execution:
- **Decision Authority**: `decided_by_type IN ('user', 'system')`.
- **Blocked Actors**: AI Agents, Chief, Tools, and Workflows are rejected with an error if attempting to approve.
- An agent proposing a publish action cannot authorize it.

---

## 5. Expiry & Lazy Resolution

- Requests can specify an optional `expires_at` (ISO-8601 UTC).
- When a request is read (`getApprovalWithExpiryCheck`) or decided after `expires_at`:
  - Automatically transitions to `status = 'expired'`.
  - Emits `approval.expired` event.
  - Rejects late approval attempts.

---

## 6. Audit & Domain Events

Every lifecycle transition records an audit trail and emits domain events:
- `approval.requested`
- `approval.approved`
- `approval.rejected`
- `approval.cancelled`
- `approval.expired`

Audit rows and events contain safe metadata only (zero credentials).

---

## 7. Database Schema (`0011_approval_requests.sql`)

```sql
CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  action_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'chief', 'agent', 'workflow', 'tool', 'system')),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'chief', 'agent', 'workflow', 'tool', 'system')),
  requested_by_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_mode TEXT NOT NULL CHECK (resolved_mode IN ('auto', 'review', 'blocked')),
  policy_source TEXT NOT NULL,
  risk TEXT,
  snapshot_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  expires_at TEXT,
  decision TEXT CHECK (decision IN ('approved', 'rejected', 'cancelled', 'expired')),
  decided_by_type TEXT CHECK (decided_by_type IN ('user', 'system')),
  decided_by_id TEXT,
  decision_note TEXT,
  decided_at TEXT,
  workflow_id TEXT,
  run_id TEXT,
  step_id TEXT,
  execution_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 9. Workflow Engine Integration (STEP 11C)

Approval Requests are seamlessly integrated with the Workflow Engine (`src/server/workflows/engine.ts`):

```text
Workflow Tool Step Encountered
  → Pre-authorized approval attached?
    ├── Yes: Verify snapshot fingerprint match → Execute Tool via executeTool({ approvalGranted: true })
    └── No: Check Policy via createApprovalRequest
          ├── AUTO → Execute Tool immediately
          ├── BLOCKED → Fail step/run cleanly with controlled `action_blocked`
          └── REVIEW → Create/Reuse Approval Request
                ├── Mark Step & Run status as 'waiting'
                ├── Persist waiting approval ID on Run state
                ├── Emit 'workflow.waiting_for_approval'
                └── Stop execution cleanly (do not execute Tool yet)
```

### Resume After Human Decision (`resumeWorkflowAfterApproval`)

1. **Approved Decision**:
   - Re-verifies approval status, expiry, and snapshot integrity.
   - Reconstructs proposed step inputs and validates them against the approved snapshot fingerprint (`approval_snapshot_mismatch` if parameters changed).
   - Re-checks agent active status, tool status, and capabilities.
   - Transitions Workflow Run from `waiting` to `running`.
   - Emits `workflow.resumed_after_approval`.
   - Continues execution with `{ authorizedApproval: { approvalRequestId, stepId, fingerprint } }`.
   - Completed previous steps are never re-run.

2. **Rejected / Cancelled / Expired Decision**:
   - Transitions waiting step and run to failed/cancelled state.
   - Tool is never executed.
   - Emits `workflow.approval_rejected`, `workflow.run_cancelled`, or `workflow.approval_expired`.

3. **Workflow Cancellation Cascade**:
   - Cancelling a waiting workflow run (`cancelWorkflowRun`) automatically cascades to cancel any pending Approval Requests linked to that run.
   - Late approvals on cancelled runs are rejected and cannot resurrect execution.

4. **Retry Authorization & Failure Safety**:
   - If a tool fails with a retryable error after approval, the approval remains valid for retry attempts as long as the snapshot parameters are identical.
   - Once the step succeeds or routes to a fallback goto, the authorized approval is cleared.

---

## 10. Verification & Tests

Run the test suites:

```bash
npm run test:approvals
npm run test:workflow-approvals
```

