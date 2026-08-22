-- 0025: Distributed refresh lease for OAuth token rotation (STEP 15E.3C.3)
-- Adds a refresh lease column to platform_credential, enabling multi-isolate
-- Cloudflare Worker environments to coordinate token refresh without blocking:
-- only the isolate that claims the lease performs the refresh endpoint call.
-- All other concurrent isolates observe the lease and proceed with the still-valid
-- (near-but-not-yet-expired) access token.
-- Never stores plaintext tokens, authorization headers, or encryption master keys.

ALTER TABLE platform_credential ADD COLUMN refresh_locked_until TEXT;
