---
name: nextjs-best-practices
description: Applies version-matched Next.js routing, rendering, data fetching, server/client boundaries, caching, metadata, and deployment practices. Use only when the repository uses Next.js.
---

# Next.js Best Practices

First detect installed Next.js version and router architecture.

Then:
- respect App vs Pages Router,
- keep server/client boundaries intentional,
- avoid accidental client expansion,
- use version-correct data/cache APIs,
- preserve route conventions,
- avoid duplicate data fetching,
- handle loading/error/not-found patterns,
- verify deployment/runtime constraints.

Never apply latest Next.js docs blindly to an older project.
