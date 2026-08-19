---
name: api-integration
description: Integrates third-party APIs and SDKs from verified contracts, installed versions, and realistic failure behavior. Use for external providers, webhooks, SDKs, and remote services.
---

# External API Integration

1. Identify installed SDK/API version.
2. Inspect existing integration.
3. Verify official contract when available.
4. Confirm auth, request, response, pagination, limits, errors.
5. Handle timeouts/partial failures where relevant.
6. Do not blindly retry non-idempotent operations.
7. Keep provider-specific behavior behind a clear boundary when practical.
8. Never invent fields or methods.
