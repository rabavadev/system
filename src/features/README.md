# src/features

Client-side feature code, one folder per domain. A feature owns its components,
hooks, and client state. Routes in `src/routes` stay thin and compose these
feature entry points. No business logic here; that lives in `src/server`.
