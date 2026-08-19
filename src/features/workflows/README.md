# workflows

Workflow definition, editing and run UI (STEP 10): the workflows list, the
non-technical step editor, workflow detail with version history and recent
runs, and the run detail page with a dev-only trace.

UI components, hooks, and client-side state for this domain live here. Business
logic does not: it belongs in `src/server`. The editor assembles plain
definition DATA; the server validates it before storing a new version.
