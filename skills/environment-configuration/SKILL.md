---
name: environment-configuration
description: Keeps development, CI, staging, and production configuration explicit, validated, documented, and separated from code and secrets. Use when adding environment variables, runtime config, deployment settings, or environment-specific behavior.
metadata: {"category":"operations","priority":"high"}
---

# Environment / Configuration Management

## Identify
- config source,
- required values,
- defaults,
- server-only secrets,
- client-safe values,
- environment differences,
- validation mechanism.

## Rules
- validate required config at startup/build boundary where appropriate,
- fail clearly on missing critical config,
- keep secrets out of source,
- document required variable names without real secret values,
- avoid environment-specific hardcodes,
- update `.env.example` or equivalent if the project uses one.

## Environment parity
Differences should be intentional and documented, not accidental.
