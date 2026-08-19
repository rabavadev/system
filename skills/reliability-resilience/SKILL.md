---
name: reliability-resilience
description: Designs failure-tolerant networked, queued, scheduled, and distributed behavior using bounded timeouts, retry policy, backoff, idempotency, graceful degradation, and recovery. Use when dependencies or asynchronous delivery can fail.
metadata: {"category":"operations","priority":"high"}
---

# Reliability / Resilience

## Failure model
Identify:
- timeout,
- transient failure,
- permanent failure,
- duplicate delivery,
- out-of-order delivery,
- partial success,
- dependency outage,
- process restart.

## Design tools
Use only when justified:
- bounded timeout,
- limited retry,
- exponential backoff,
- jitter,
- idempotency keys,
- deduplication,
- circuit breaking,
- dead-letter handling,
- graceful degradation.

## Retry rule
Retry only failures likely to succeed later and only when repeating the operation is safe or protected.

## Exit criteria
Failure behavior is intentional, bounded, observable, and tested at the important boundary.
