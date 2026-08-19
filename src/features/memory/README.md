# memory

Explicit workspace memory UI and server functions.

- `memory-page.tsx` — compact Memory workspace, filters, detail and actions
- `memory-editor.tsx` — create/edit/verify/replace/save-from-chat dialog
- `memory-view.ts` — client-only grouping/filter helpers (no ranking logic)
- `wire.ts` — isolated client/server validation schemas
- `server.ts` — server functions; all writes go through `src/server/db/memory.ts`

Behavior rules live in `src/server/memory/rules.ts`; retrieval/ranking stay in
the STEP 5 Context Engine.
