---
name: browser-runtime-testing
description: Validates a running web application using browser-visible behavior, console errors, network activity, DOM state, responsive layouts, and accessibility rather than source inspection alone.
---

# Browser Runtime Testing

## Use when
UI or browser behavior matters.

## Validate
- page actually renders,
- primary interactions work,
- console has no relevant errors,
- network requests succeed as expected,
- loading/error states appear correctly,
- route transitions work,
- responsive layouts do not overflow/break,
- DOM/accessibility state matches intent.

## Rule
Source review cannot prove runtime UI behavior.

If browser tooling is unavailable, explicitly mark runtime behavior as not verified.
