---
name: observability
description: Adds production-grade structured logs, metrics, traces, correlation, and actionable error visibility without leaking sensitive data. Use for backend/services or features that need operational diagnosis.
---

# Observability

Instrument around meaningful system behavior:
- request/error rate,
- latency,
- critical business operation success/failure,
- dependency failures,
- queue/job outcomes where relevant.

Prefer:
- structured logs,
- correlation/request IDs,
- metrics with bounded cardinality,
- traces around distributed/slow paths.

Never log secrets or private payloads casually.

Observability should answer: what failed, where, for whom/what request, and how often?
