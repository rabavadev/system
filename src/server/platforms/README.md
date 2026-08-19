# server/platforms

Platform adapters. One adapter per external platform behind a common interface, so the app never depends on a single platform.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files).
