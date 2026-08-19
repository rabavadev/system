# Growth Workspace

A long-term AI growth workspace. Foundation + D1 database layer. No business
logic, no platform-specific or AI-provider-specific code.

## Stack

- TanStack Start (React 19) on Cloudflare Workers
- TanStack Router (file-based) + TanStack Query
- TypeScript strict mode
- Tailwind CSS v4
- Cloudflare D1 (SQLite) with wrangler migrations
- Biome (lint + format), zod (write validation)

## Requirements

- Node.js 22+ (see `.nvmrc`; enforced via `engines` in package.json)
- npm 10+

## Getting started

```sh
npm install
npm run cf-typegen        # generate worker-configuration.d.ts (gitignored)
npm run db:migrate:local  # create the local D1 schema
npm run db:seed           # one default workspace + platform/metric reference data
npm run dev               # local dev on :3000 (runs on a real Worker runtime)
```

## Commands

```sh
npm run dev         # local dev on :3000 (runs on a real Worker via @cloudflare/vite-plugin)
npm run build       # production build
npm run preview     # preview the build
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # biome check
npm run deploy      # build + wrangler deploy
npm run cf-typegen  # regenerate Cloudflare binding types
npm run db:migrate:local   # apply migrations to local D1
npm run db:migrate:remote  # apply migrations to the real D1 (needs database_id)
npm run db:seed            # idempotent dev seed
npm run db:test            # fresh-DB migration + constraint test suite
```

## Database

See [docs/database.md](docs/database.md) for the schema, relationships,
scoping/versioning/deletion doctrine, and secrets policy. All schema changes
are migrations in `migrations/`; never edit the database by hand.


## Structure

```
src/
  routes/       TanStack Router file routes (thin; compose feature screens)
  components/   Shared layout and UI primitives
  features/     Client-side feature code, one folder per domain
  lib/          Shared client utilities (env, query client, helpers)
  server/       Server-only boundaries: db, ai, context, agents, workflows,
                tools, platforms, events, jobs
  types/        Shared domain and binding types
```

## Boundaries that matter

- **Server vs client.** `src/server` is never imported by UI code. Client code
  reaches the server through TanStack Start server functions.
- **AI providers.** All model access goes through `src/server/ai`. Provider
  names do not appear anywhere else.
- **Platforms.** Each external platform will be an adapter in
  `src/server/platforms` behind a common interface.
- **Data.** D1 access lives only in `src/server/db`. Files in R2 behind
  `src/features/files` + a server boundary (later).

## Environment

Copy `.env.example` to `.env` for client vars. Server-only secrets go in
`.dev.vars` (gitignored) for local dev and `wrangler secret` in production.
Before deploying, replace the placeholder `database_id` in `wrangler.jsonc`
with the id from `wrangler d1 create growth-workspace`.
