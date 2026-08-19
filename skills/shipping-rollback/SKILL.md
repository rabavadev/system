---
name: shipping-rollback
description: Prepares high-impact changes for safe release with verification, migration readiness, feature flags or staged rollout when appropriate, success criteria, monitoring, and rollback.
---

# Shipping and Rollback

Before release verify:
- tests/build,
- runtime behavior,
- migration readiness,
- configuration/secrets,
- monitoring,
- compatibility,
- rollback/recovery.

For risky changes consider:
- feature flags,
- staged rollout,
- canary,
- reversible migrations,
- explicit success/failure criteria.

After deploy:
- validate critical path,
- inspect error/latency signals,
- rollback when predefined failure criteria are met.

Do not discover the rollback plan after production breaks.
