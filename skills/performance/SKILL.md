---
name: performance
description: Diagnoses and fixes real application performance bottlenecks without speculative optimization. Use when evidence or architecture indicates meaningful network, database, CPU, rendering, bundle, or memory cost.
---

# Performance

1. Identify resource: network/database/CPU/render/bundle/memory.
2. Obtain evidence when possible.
3. Find biggest avoidable cost.
4. Prefer simple fixes:
   - remove duplicate work,
   - batch,
   - paginate,
   - narrow query,
   - index,
   - avoid unnecessary renders.
5. Add caching only with clear invalidation/ownership.
6. Re-evaluate after change.

Do not optimize by superstition.
