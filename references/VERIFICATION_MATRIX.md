# Verification Matrix

| Change | Minimum evidence |
|---|---|
| Docs only | diff review |
| Small local code | targeted check + type/lint where available |
| Feature | tests + type/lint/build + behavior check |
| UI | feature checks + browser/runtime validation |
| Shared architecture | broader dependents + canonical source review |
| Migration/data | existing-data compatibility + rollback + tests |
| Auth/permissions/billing | high-risk review + failure paths + behavior evidence |
| Release | build artifact + runtime smoke + monitoring + rollback readiness |
