---
name: stack-freshness
description: Verifies the repository's actual framework, library, runtime, and SDK versions before using version-sensitive APIs. Use whenever implementation correctness depends on current stack behavior.
---

# Stack Freshness

1. Read manifest.
2. Read lockfile if needed.
3. Inspect framework config.
4. Inspect current local usage/types.
5. Determine exact installed version.
6. Prefer supported project patterns.
7. If external docs are available, use official docs matching the installed version.
8. Flag touched deprecated usage when relevant.

Never upgrade the stack just to use a familiar API.
