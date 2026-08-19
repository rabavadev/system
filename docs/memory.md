# Memory behavior (STEP 7)

The Memory system is explicit and reviewable. It stores what the workspace
should remember without letting chat text silently become trusted truth.

## Memory classes

| User label | Stored class | Behavior |
|---|---|---|
| Important Fact | `permanent_fact` | Slow-changing rules, positioning, constraints and stable audience facts. It stays active until edited, replaced, archived or given an expiry. |
| Verified Learning | `verified_learning` | Evidence-backed finding. Requires confidence and evidence; verification time is stored server-side. |
| Needs Verification | `proposed_learning` | A hypothesis. The Context Engine always passes it to Chief as `hypothesis`, never as trusted fact. |
| Temporary | `temporary_context` | Short-lived working context. Supports expiry, manual archive and restore. |

## Scope and safety

Every memory applies to the workspace or one real entity: brand, niche,
product, account, platform or campaign. The server validates the target and
its relationships before writing:

- scoped entities must exist and belong to the current workspace
- archived targets cannot receive new memory
- products/niches/campaigns must agree with any supplied brand/niche/product
  context
- accounts cannot be attached to a brand they are not associated with
- platform memory uses the seeded platform registry

The client never supplies `workspaceId`, status, verification timestamps,
source type, or supersession ids. Chat-sourced memory passes only the
reviewed message id; the server derives whether the source was You or Chief.

## Transitions

Centralized in `src/server/memory/rules.ts` and enforced by
`src/server/db/memory.ts`:

- Proposed Learning → Verified Learning, with confidence + evidence
- Proposed Learning → Rejected
- Active memory → Archived
- Archived → Restored (expired memory remains expired by date)
- Active non-temporary memory → Replaced by a new memory of the same class
- Temporary memory expires by `expires_at` or is archived manually

A memory cannot replace itself. Replacing marks the old row `superseded` and
points it at the replacement; history is preserved.

## Evidence, confidence and provenance

Confidence is Low/Medium/High in the UI and stored as a bounded numeric value.
Evidence is a lightweight JSON note list. Sources shown in the UI are You,
Chief, Research, Analytics or Imported data; STEP 7 only creates You/Chief
provenance because no autonomous research or analytics memory writers exist.

## Context Engine compatibility

No ranking or freshness logic is duplicated in the UI. The Context Engine
continues to exclude archived, rejected, superseded and expired memory, maps
proposed learning to `hypothesis`, and ranks exact scope above broader scope.

## Audit

Create, edit, verify, replace, archive, restore and reject actions write
`audit_log` snapshots and small `memory.*` domain events. Event payloads carry
metadata, not secrets.

## Not built yet

Autonomous memory extraction, automatic permanent memory, embeddings,
Vectorize and semantic search remain intentionally out of scope.
