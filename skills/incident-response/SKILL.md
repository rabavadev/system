---
name: incident-response
description: Coordinates active production failures through containment, mitigation, evidence preservation, rollback, root-cause repair, verification, and post-incident follow-up. Use when service is currently degraded or causing user/data impact.
metadata: {"category":"operations","priority":"critical"}
---

# Production Incident Response

## Phase 1 — Triage
Determine:
- impact,
- affected users/services,
- start time/window,
- data/security risk,
- whether damage is ongoing.

## Phase 2 — Contain / Restore
Prefer the safest reversible action:
- rollback,
- disable a flag,
- stop a bad job,
- isolate a dependency,
- rate-limit or degrade non-critical functionality.

Do not perform unrelated refactors.

## Phase 3 — Preserve evidence
Capture relevant:
- logs,
- traces,
- deploy/change identifiers,
- failing requests,
- metrics.

## Phase 4 — Diagnose and repair
Use root-cause debugging after service is stable enough.

## Phase 5 — Verify
Validate recovery and watch relevant signals.

## Phase 6 — Follow-up
Record:
- root cause,
- contributing conditions,
- detection gap,
- corrective action,
- recurrence prevention.

Use `documentation-adrs` only if a lasting architecture decision results.
