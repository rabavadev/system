---
name: security
description: Reviews authentication, authorization, ownership, untrusted input, secrets, logs, destructive actions, and least privilege. Use for security-sensitive or user-data changes.
---

# Security Review

## First identify the threat surface
- authentication,
- authorization/ownership,
- untrusted input,
- browser/web boundary,
- APIs/webhooks,
- files/uploads,
- secrets/config,
- dependency/supply chain,
- sensitive user data.

## Core procedure
1. Identify assets and trust boundaries.
2. Verify authentication.
3. Verify authorization and ownership at trusted boundaries.
4. Validate untrusted input.
5. Check output encoding/query construction as applicable.
6. Check secret exposure and logging.
7. Check destructive actions and retry safety.
8. Check dependency/config changes.
9. Test important failure/abuse paths.
10. Verify least privilege.

## Load references only when relevant
- `references/threat-model.md`
- `references/web-security.md`
- `references/secrets.md`
- `references/uploads-webhooks.md`
- `references/dependency-supply-chain.md`

Use `privacy-data-governance` for minimization/retention/export/deletion questions.

Security findings should name:
- attack/failure path,
- impacted asset,
- concrete evidence,
- recommended fix,
- verification.
