---
name: code-simplification
description: Simplifies overengineered or AI-generated code without changing required behavior. Use when code works but contains needless layers, duplication, wrappers, indirection, or speculative abstractions.
---

# Code Simplification

Look for:
- one-use factories/providers/services,
- wrappers with no semantic value,
- duplicated conversion/formatting logic,
- unnecessary state mirrors,
- excessive prop threading caused by poor ownership,
- abstraction layers built for hypothetical futures.

Procedure:
1. define behavior to preserve,
2. identify simplest ownership/boundary,
3. remove unnecessary indirection,
4. keep names/domain meaning clear,
5. verify behavior unchanged.

Simplification is not code golf.
