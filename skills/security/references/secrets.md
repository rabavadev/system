# Secrets Reference

Secrets include credentials, private tokens, signing keys, DB passwords, and provider keys.

Rules:
- never commit real values,
- never log them,
- never expose server-only values to client bundles,
- use the project's secret/config mechanism,
- rotate/revoke if exposure is discovered,
- keep examples obviously fake.
