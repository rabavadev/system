# Project Rules

This file must contain repository-specific facts only.

## Product
- Product: Growth Workspace — long-term AI growth workspace
- Primary users: solo operators / small teams running brand growth
- Primary user goal: manage brands, niches, products, accounts and (later) AI agents/conversations in one workspace
- Non-goals: platform-specific code, AI-provider-specific code, fake AI behavior

## Stack
```text
Framework: TanStack Start (React 19), file-based TanStack Router
Language: TypeScript strict (~5.9)
Runtime: Cloudflare Workers (@cloudflare/vite-plugin, real Worker in dev)
Package manager: npm 10+ (Node 22+, enforced via engines)
UI/styling: Tailwind CSS v4, lucide-react icons, own ui primitives
State: TanStack Query
Backend: TanStack Start server functions
Database: Cloudflare D1 (SQLite), wrangler migrations in migrations/
Auth: single default workspace (dev seed); workspace scoping server-side
Testing: scripts/test-db.mjs (constraints), scripts/test-relations.ts (relations)
Deployment: wrangler deploy
```

## Commands
```bash
npm install               # install
npm run dev               # dev on :3000 (real Worker runtime)
npm run typecheck         # tsc --noEmit (strict)
npm run lint              # biome check .
npm run db:test           # fresh-DB migration + constraint suite
npm run test:relations    # relationship-integrity suite
npm run build             # production build
npm run cf-typegen        # regenerate worker-configuration.d.ts (gitignored)
npm run db:migrate:local  # apply migrations to local D1
npm run db:seed           # idempotent dev seed
```

## Canonical Architecture
```text
App entry: src/routes/__root.tsx + src/router (TanStack Start default)
Primary dashboard route: src/routes/index.tsx (home)
Dashboard shell: src/components/layout/app-shell.tsx
Navigation: src/components/layout/nav-items.ts + topbar.tsx
Auth state: n/a yet — single workspace from seed
Current-user state: n/a; active brand selection via cookie (src/features/workspace/server.ts)
API client: TanStack Start server functions per feature (src/features/*/server.ts)
Database/schema source: migrations/ (immutable) + docs/database.md
Design token source: Tailwind v4 theme (src/styles), ui primitives in src/components/ui/
Shared component library: src/components/ui/ + src/components/layout/
```

## Business Rules
- Platform agnostic, model agnostic. No OpenAI/Anthropic/Gemini coupling anywhere.
- Brand ≠ Niche. Account may belong to multiple niches (account_niche).
- React components never query D1 directly: client → server function → validation → repository → D1.
- Writes go through validated server functions/repositories (zod).
- Soft deletion everywhere on business entities (`deleted_at`); history tables never deleted.
- No secrets in business tables (see docs/database.md secrets policy).
- Do NOT derive client/server wire zod schemas from repository schemas at module level
  inside server-function files — it breaks `cloudflare:workers` client tree-shaking.
  Keep wire validation schemas isolated.

## Security / Permissions
- All reads/writes scoped to the current workspace server-side.
- Client must never be able to set privileged fields (e.g. message sender_type=agent).
- IDs are TEXT UUIDs generated application-side; never exposed as internal concepts in UI copy.
