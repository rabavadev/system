---
name: privacy-data-governance
description: Reviews collection, storage, logging, retention, export, deletion, minimization, and isolation of personal or sensitive user data. Use when features introduce or modify user data handling.
metadata: {"category":"data-safety","priority":"high"}
---

# Privacy / Data Governance

## Classify data
Identify:
- personal data,
- sensitive data,
- credentials/secrets,
- analytics/telemetry,
- user-generated content.

## Ask
- Is this data necessary?
- Can less be collected?
- Where is it stored?
- Who/what can access it?
- Is it copied into logs/analytics?
- How long is it retained?
- How is it exported/deleted?
- Is tenant/user isolation preserved?

## Rules
- minimize collection,
- avoid duplicating PII into convenience tables/logs,
- avoid exposing sensitive fields in API responses,
- make deletion/export behavior consistent with the product's requirements,
- preserve auditability where required by the project.

Do not invent legal/compliance requirements. Record project-specific requirements in `PROJECT_RULES.md`.
