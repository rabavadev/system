# Central Approval Policy System (STEP 11A)

The Approval Policy system provides the central configuration answering:

> **"What should happen when this kind of action is requested?"**

It is separate from individual **Approval Requests** (`pending` rows awaiting user decision) and **Approval Center** (which will be built in subsequent steps).

```text
Action Request (actionKey, scope, origin, risk, target)
  → Central Policy Resolver (src/server/policy/resolver.ts)
    → 1. Hard Security Check (non-overridable invariants)
    → 2. Brand Override Check (if brand scope is active)
    → 3. Workspace Policy Check (if workspace policy is set)
    → 4. Risk Fallback (derived from STEP 9 Tool risks)
    → 5. Safe System Default (canonical default mode)
  → PolicyResolutionResult (mode: auto | review | blocked, source, trace)
```

---

## 1. Canonical Vocabulary

Three canonical modes only:

| Mode | User-facing label | Meaning |
|---|---|---|
| `auto` | Auto | Action executes immediately without requiring human review. |
| `review` | Review first | Action generates a review/approval requirement before execution. |
| `blocked` | Blocked | Action is forbidden and cannot execute. |

No alternative aliases or redundant states exist.

---

## 2. Stable Action Keys

Platform-neutral action taxonomy:

| Action Key | Label | Category | Safe Default | Description |
|---|---|---|---|---|
| `workspace.read` | Research / read information | `read` | `auto` | Read workspace context, products, and metadata. |
| `workflow.run` | Run workflows | `workflow` | `review` | Execute multi-step automated workflows. |
| `workflow.create` | Create workflows | `workflow` | `review` | Create new workflows or draft versions. |
| `workflow.modify` | Change workflows | `workflow` | `review` | Save new versions of existing workflows. |
| `memory.verify` | Verify learned memory | `memory` | `review` | Graduate candidate hypotheses to verified facts. |
| `external.read` | Read external services | `external` | `review` | Search or read information from connected external services. |
| `external.write` | Outside service changes | `external` | `review` | Mutating actions on external platform connections. |
| `content.publish` | Publish content | `content` | `review` | Publish posts and media to platforms. |
| `account.modify` | Modify account settings | `account` | `review` | Modify platform account configurations. |
| `destructive.delete` | Delete important data | `system` | `blocked` | Hard or permanent deletion of entities. |

Action keys never mention specific platforms (no Pinterest/Twitter/etc. in keys).

---

## 3. Scopes & Precedence

Deterministic evaluation order:

```text
1. Hard Security Invariants (cannot be overridden by any policy)
   ↓
2. Brand Override (when requesting action under a specific brand)
   ↓
3. Workspace Policy (workspace-wide custom configuration)
   ↓
4. Tool Risk Fallback (when action carries STEP 9 risk metadata)
   ↓
5. Safe System Default (built-in baseline)
```

If a brand override is cleared, evaluation immediately returns to inherited workspace policy.

---

## 4. Hard Security Invariants

Some restrictions sit strictly above user policy. An `AUTO` setting never means "ignore security."

Hard security blocks:
1. **Secret Exposure**: Access to credentials, tokens, or `secret_ref`.
2. **Cross-Workspace Bypass**: Cross-workspace access violates tenant boundaries.
3. **Arbitrary Code Execution**: `eval` or dynamic script execution.
4. **Security Enforcement Bypass**: Disabling capabilities or bypassing gates.

When violated, `resolveApprovalPolicy` returns `blocked` with `source: 'hard_security'`, overriding any workspace or brand rule.

---

## 5. Tool Risk Integration

Reuses STEP 9 Tool risk classifications (`read`, `write`, `external`, `sensitive`, `destructive`):

- `destructive` / `sensitive` → `blocked`
- `write` / `external` → `review`
- `read` → `auto`

---

## 6. Request Origin Metadata

The resolver records the actor origin for future governance:
- `user`
- `chief`
- `agent`
- `workflow`
- `tool`
- `system`

---

## 7. Storage & Audit History

Schema lives in `migrations/0010_approval_policy.sql`:

```sql
CREATE TABLE approval_policy (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'brand', 'account', 'platform', 'workflow')),
  scope_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'review', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, scope_type, scope_id, action_key)
);
```

### Auditing & Domain Events
- Every mutation logs to `audit_log` (`entity_type: 'approval_policy'`, with before/after mode snapshots; zero secrets).
- Emits domain events (`policy.created`, `policy.updated`, `policy.deleted`).

---

## 8. Settings UI & Dev Resolver Trace

- **Settings Screen (`/settings`)**: Hosts the minimal **Autonomy & Approval Policy** section with readable action rows, segmented buttons (`Auto`, `Review first`, `Blocked`), and Brand Override selection/clearing.
- **Policy Trace Inspector (Dev)**: Interactive tool in Settings allowing operators to inspect the exact step-by-step resolution chain and decision logic.

---

## 9. Tests

Run the policy test suite:

```bash
npm run test:policy
```
