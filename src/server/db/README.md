# server/db

Database access boundary. All D1 access goes through this folder; nothing
outside it talks to D1. See `docs/database.md` for the full doctrine.

- `client.ts` — binding access (`getDb`), id/timestamp generation
  (`newId`, `nowIso`), typed query helpers.
- `workspace.ts`, `memory.ts`, `campaign.ts` — repositories with colocated
  zod write validation. Add a repository when a feature actually needs one;
  do not pre-generate CRUD for every table.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files). Client code reaches this layer through
TanStack Start server functions in `src/features/*/server.ts`.
