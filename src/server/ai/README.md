# server/ai

AI provider abstraction. All model calls go through this boundary so providers are swappable. Cloudflare AI Gateway sits in front later. No provider names elsewhere in the codebase.

Server-only code. Never import from client bundles (`src/components`,
`src/routes`, `src/features` UI files).
