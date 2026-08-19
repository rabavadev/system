# Project Rules Template

Copy/customize this as `PROJECT_RULES.md`.

The agent should discover as much as possible from the repository before asking the user.

## Product
- Product:
- Primary users:
- Primary user goal:
- Non-goals:

## Stack (discover exact versions)
```text
Framework:
Language:
Runtime:
Package manager:
UI/styling:
State:
Backend:
Database:
Auth:
Testing:
Deployment:
```

## Commands
```bash
# install
# dev
# typecheck
# lint
# test
# build
# e2e
```

## Architecture
```text
Routing:
Frontend data flow:
State ownership:
API layer:
Backend/service boundaries:
Database access:
Auth boundary:
Shared UI:
Feature/module boundaries:
```

## Canonical Implementations
```text
Main dashboard route:
Dashboard shell:
Navbar:
Sidebar:
Button:
Modal/Dialog:
Form primitives:
Auth state:
Current user state:
API client:
Design tokens:
```

## Naming
```text
Files:
Components:
Hooks:
Services:
Database fields:
Domain terms:
```

## UI / Design System
```text
Token source:
Typography:
Spacing:
Radius:
Colors:
Components:
Responsive rules:
Loading/empty/error patterns:
```

## Business Rules
Document rules that code alone should not redefine.

## Data Rules
```text
Persisted user settings:
Migration constraints:
Deletion policy:
Legacy data concerns:
```

## Security / Permissions
```text
Roles:
Ownership:
Admin actions:
Sensitive endpoints:
```

## External Integrations
For each:
```text
Provider:
Installed SDK/version:
Auth:
Rate limits:
Retry/idempotency:
Webhook behavior:
```

## Decisions That Must Not Change Silently
- ...

## Known Technical Debt
- ...

## High-Risk Areas
- ...
