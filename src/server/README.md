# src/server

Server-only code, organized by boundary. Nothing in here is imported by client
UI. Client code reaches the server through TanStack Start server functions,
which live with their feature and delegate into these modules.

Each subfolder has its own README describing its responsibility.
