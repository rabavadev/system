-- 0026: Fencing token for distributed refresh claim ownership (HARDENING 15E.3C.3.2)
-- Adds refresh_claim_id to platform_credential to ensure database-authoritative fencing:
-- When a Worker isolate claims the refresh lease, it writes a unique claim ID.
-- Refreshed tokens can ONLY be persisted if the exact claim ID matches the active row,
-- preventing stale workers whose lease has expired from overwriting newer credentials.
-- Never stores plaintext tokens, authorization headers, or encryption master keys.

ALTER TABLE platform_credential ADD COLUMN refresh_claim_id TEXT;
