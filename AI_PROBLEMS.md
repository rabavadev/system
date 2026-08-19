# AI Coding Problems

This document defines common failure modes of AI coding agents.

The purpose is **not** to define the rules yet.

First, we identify the recurring problems. Later, each problem can be converted into one or more strict coding rules.

---

## 1. AI Fixes Symptoms Instead of Root Causes

AI often patches the visible problem without understanding why it happened.

### Common behavior

- Adds another event handler instead of fixing the existing flow.
- Adds conditions around broken logic instead of repairing the underlying state.
- Creates workaround code instead of correcting architecture.
- Repeats patches when the same issue appears elsewhere.

### Result

- Technical debt grows.
- Duplicate logic appears.
- Bugs return later.
- The codebase becomes harder to reason about.

---

## 2. AI Assumes Existing Code Is Correct

AI often treats the current codebase as the source of truth.

This is especially dangerous in projects that were already generated or heavily modified by AI.

### Problem

Existing architecture may itself be wrong.

AI tends to think:

```text
Existing architecture = preserve it
```

Instead of asking:

```text
Should this architecture exist at all?
```

### Result

Bad decisions become permanent foundations for future work.

---

## 3. AI Changes Too Much

A small task can turn into an unnecessary project-wide refactor.

Example:

> Fix the login redirect.

AI may also:

- Refactor authentication.
- Rename files.
- Change components.
- Add dependencies.
- Modify database types.
- Reorganize unrelated code.

### Result

Unrelated systems can break and the original task becomes harder to review.

---

## 4. AI Changes Too Little

AI can also make superficial changes when deeper work is required.

Example:

> Redesign this bad page.

AI changes only:

- Border radius.
- Shadows.
- Font sizes.
- Colors.

But leaves broken:

- Layout.
- Information hierarchy.
- Navigation.
- Page structure.
- User flow.
- Component architecture.

### Result

The page looks slightly different but the actual problem remains.

---

## 5. AI Starts Coding Before Understanding the Project

AI often begins editing immediately.

It may fail to inspect:

- Project structure.
- Related components.
- Routes.
- State management.
- Existing utilities.
- Data flow.
- Backend contracts.
- Dependencies.
- Shared design systems.
- Existing abstractions.

### Result

AI creates duplicate or conflicting systems.

---

## 6. AI Invents Things That Do Not Exist

AI may hallucinate project functionality.

Examples:

- API endpoints.
- Database fields.
- Component props.
- Library functions.
- Environment variables.
- Routes.
- Package APIs.
- Configuration values.

### Result

Code may look valid while depending on systems that do not exist.

---

## 7. AI Duplicates Existing Functionality

AI often creates a new helper without checking whether one already exists.

Example:

```ts
formatCurrency()
```

Then later:

```ts
formatMoney()
```

And eventually:

```ts
currencyFormatter()
```

### Result

- Multiple implementations of the same behavior.
- Inconsistent output.
- More maintenance.
- Harder refactoring.

---

## 8. AI Over-Engineers Simple Problems

Simple requirements can become unnecessarily complex architecture.

A basic toggle may become:

```text
ToggleProvider
ToggleContext
useToggleState
ToggleService
ToggleRepository
ToggleFactory
```

### Result

- More files.
- More abstractions.
- Harder debugging.
- Slower development.
- Higher maintenance cost.

---

## 9. AI Under-Engineers Important Systems

AI can do the opposite with systems that actually require careful design.

Common areas:

- Authentication.
- Authorization.
- Permissions.
- Payments.
- Validation.
- Error handling.
- Caching.
- Database operations.
- Security-sensitive logic.

### Result

Critical systems may work only in ideal conditions and fail in real use.

---

## 10. AI Does Not Think Through the Full User Flow

AI can make individual screens work without checking how they connect.

A real flow may be:

```text
User enters
→ performs an action
→ receives feedback
→ navigates
→ returns later
```

AI may only implement the middle action.

### Result

- Dead ends.
- Missing navigation.
- Confusing states.
- No return path.
- Features that technically work but feel broken.

---

## 11. AI Builds UI From Backend Structure Instead of User Needs

AI often exposes technical structure directly in the interface.

Example:

If the backend contains 14 settings, AI may display all 14 settings to the user.

That does not mean the user needs to see them.

### Result

- Technical-looking dashboards.
- Too many controls.
- Poor prioritization.
- Confusing interfaces.
- Backend concepts leaking into UX.

---

## 12. AI Produces Generic AI-Looking UI

AI-generated interfaces often fall into the same visual patterns.

Common signs:

```text
Card
Card
Card
Card

Large heading
Small subtitle

Gradient
Rounded corners
Shadow
```

### Problems

- Weak visual hierarchy.
- No product identity.
- Repetitive layouts.
- Excessive cards.
- Decorative gradients without purpose.
- Generic dashboard structure.

### Result

The interface looks generated rather than intentionally designed.

---

## 13. AI Ignores Empty, Loading, Error, and Edge States

AI frequently designs only the ideal case.

It assumes:

- Data exists.
- APIs succeed.
- Internet works.
- Inputs are valid.
- Users follow the expected path.
- Permissions are available.

### Missing states often include

- Loading.
- Empty.
- Error.
- Partial data.
- Offline.
- Unauthorized.
- Validation errors.
- Retry states.
- Disabled states.

### Result

Features break or become confusing outside the perfect demo scenario.

---

## 14. AI Leaves Dead Code Behind

When replacing functionality, AI may leave the old implementation in the project.

Examples:

- Old components.
- Unused imports.
- Deprecated utilities.
- Abandoned styles.
- Old routes.
- Unused API calls.
- Duplicate state.
- Commented-out code.

### Result

The codebase becomes harder to understand and future AI agents may accidentally reuse obsolete systems.

---

## 15. AI Adds Dependencies Without Enough Reason

AI may install a package for functionality that could be implemented simply with existing tools.

### Result

Every extra dependency can add:

- Maintenance.
- Bundle size.
- Security surface.
- Compatibility risks.
- Upgrade problems.
- Dependency conflicts.

---

## 16. AI Breaks Product Consistency

AI can implement the same concept differently across different parts of the product.

Example:

```text
Save
Update
Apply Changes
Confirm
```

may all describe the same action.

The same problem happens with:

- Spacing.
- Buttons.
- Modals.
- Forms.
- Navigation.
- Colors.
- Terminology.
- Error messages.
- Loading patterns.

### Result

The product feels like several unrelated interfaces stitched together.

---

## 17. AI Does Not Properly Validate Its Own Work

AI often assumes that code which looks logically correct must work.

It may skip checking:

- Type errors.
- Lint errors.
- Build failures.
- Tests.
- Runtime behavior.
- Console errors.
- Broken routes.
- Regression risks.
- Mobile behavior.
- Integration behavior.

### Result

Broken code can be presented as finished.

---

## 18. AI Claims Completion Without Evidence

AI frequently says:

> Implemented successfully.

or:

> The feature is complete.

without fully verifying the result.

Possible hidden problems:

- TODOs remain.
- Mock data remains.
- Buttons are not connected.
- Backend calls are missing.
- Mobile layout is broken.
- Error states are missing.
- Routes are incomplete.
- Tests fail.

### Result

Completion claims become unreliable.

---

## 19. AI Uses Fake or Mock Content Without Clearly Controlling It

During UI work, AI may invent realistic-looking data.

Examples:

```text
John Doe
$42,938 revenue
+27.4%
12,482 users
```

### Problem

Mock data can be useful during development, but it should not silently replace real product behavior.

### Result

- Fake metrics leak into production UI.
- Developers misunderstand what is connected.
- UI appears complete when functionality is missing.

---

## 20. AI Confuses Examples With Requirements

When given a reference such as:

> Make it feel like Linear.

AI may interpret that as:

> Copy Linear.

### Problem

References should communicate qualities such as:

- Density.
- Clarity.
- Motion.
- Hierarchy.
- Simplicity.
- Interaction style.

They should not automatically become exact specifications.

### Result

The product loses its own identity and may inherit patterns that do not fit its users.

---

## 21. AI Follows User Instructions Too Literally

A user may request:

> Add a button here.

But the actual problem may not require another button.

A strong coding agent should understand the intention behind the request and recognize when a different implementation is better.

### Result

Literal compliance can create worse UX or architecture.

---

## 22. AI Does Not Challenge Bad Architecture

AI often continues modifying components that are failing because the architecture underneath them is wrong.

Example:

Five components are fighting over state.

AI modifies all five instead of fixing where the state should live.

### Result

- Increasing complexity.
- More synchronization bugs.
- More patches.
- Harder future changes.

---

## 23. AI Forgets Previous Project Decisions

As conversations and coding sessions grow, AI may contradict earlier decisions.

Example:

```text
Earlier:
"We will use X."

Later:
"I implemented Y."
```

### Result

- Architecture drifts.
- Libraries change unexpectedly.
- Naming becomes inconsistent.
- Previously rejected ideas return.
- Project direction becomes unstable.

---

## 24. AI Introduces Regressions While Fixing Other Problems

AI may fix feature A while accidentally breaking feature B.

This often happens because it reasons locally.

It fails to check questions such as:

```text
What depends on this?
What calls this?
What state does this affect?
What contracts am I changing?
What other flows use this component?
```

### Result

One bug disappears and another appears elsewhere.

---

## 25. AI Optimizes for Producing Code Instead of Producing a Good Product

This is one of the deepest problems.

AI naturally tends toward producing visible output quickly.

Bad workflow:

```text
Prompt
→ immediately write code
```

Better engineering requires:

```text
Inspect
→ understand
→ question
→ simplify
→ design
→ implement
→ verify
→ clean up
```

### Result

Fast code generation can create slow long-term development.

---

# Core Problem Categories

These problems can later be converted into rules under eight main categories.

## 1. Understand Before Editing

AI must understand the relevant system before changing it.

## 2. Find the Root Cause

AI should repair underlying causes rather than stack patches.

## 3. Protect Working Behavior

Changes should avoid unnecessary regressions and unrelated modifications.

## 4. Prefer Simplicity

AI should avoid unnecessary abstractions, dependencies, and duplication.

## 5. Maintain Architecture and Consistency

The project should remain internally coherent instead of accumulating conflicting patterns.

## 6. Think From the User's Perspective

Implementation should serve the user flow, not simply mirror technical structure.

## 7. Verify Every Change

Code should be checked through appropriate build, test, runtime, and integration validation.

## 8. Never Claim Completion Without Evidence

AI should only state that work is complete when the relevant implementation has actually been verified.

---

# Next Stage

This document describes the **problems** only.

The next document should convert these failure modes into strict, enforceable AI coding rules.

Suggested future file:

```text
AI_CODING_RULES.md
```

---

# Additional AI Coding Problems

## 26. AI Ignores Security Implications

AI may make changes without considering security consequences.

Common failures include:

- Exposing secrets.
- Trusting client-side input.
- Weakening authentication checks.
- Creating insecure endpoints.
- Logging sensitive information.
- Using unsafe defaults.

### Result

A feature may appear to work while introducing serious security vulnerabilities.

---

## 27. AI Modifies Destructive Systems Too Casually

Some systems require a much higher level of caution.

Examples:

- Database deletion.
- Account deletion.
- Billing logic.
- Authentication changes.
- File deletion.
- Production configuration.
- Permission changes.
- Data migrations.

### Result

A small mistake can cause irreversible damage or data loss.

---

## 28. AI Writes Unsafe Database Migrations

AI may change database structure without checking existing production data.

Examples:

- Dropping columns.
- Renaming fields.
- Changing data types.
- Removing constraints.
- Rewriting relationships.
- Assuming migrations are reversible.

### Result

Existing user data can become invalid, inaccessible, or permanently lost.

---

## 29. AI Ignores Backward Compatibility

AI may change:

- API contracts.
- Function signatures.
- Stored data formats.
- Database fields.
- Component interfaces.
- Event payloads.

without checking whether older code still depends on them.

### Result

Existing clients or features can break unexpectedly.

---

## 30. AI Ignores Performance Until It Becomes Obvious

AI often focuses only on correctness.

It may create:

- Repeated API calls.
- N+1 queries.
- Huge database queries.
- Unnecessary re-renders.
- Duplicate computations.
- Large client bundles.
- Loading entire datasets at once.

### Result

The application works during development but becomes slow under real usage.

---

## 31. AI Optimizes Performance Prematurely

AI may also introduce complexity before a real performance problem exists.

Examples:

- Caching.
- Memoization.
- Queues.
- Workers.
- Complex state systems.
- Background synchronization.
- Custom optimization layers.

### Result

Complexity increases without measurable benefit.

---

## 32. AI Handles Async and Concurrency Badly

AI may fail to account for multiple operations happening at the same time.

Common problems:

- Race conditions.
- Double submissions.
- Stale responses.
- Duplicate requests.
- Conflicting state updates.
- Requests finishing after navigation.
- Out-of-order updates.

### Result

Behavior becomes unpredictable under real interaction.

---

## 33. AI Does Not Consider Idempotency

Some actions must be safe if triggered more than once.

Examples:

- Create.
- Pay.
- Send.
- Submit.
- Redeem.
- Claim.
- Delete.

### Result

Double clicks or retries can accidentally perform the same operation multiple times.

---

## 34. AI Ignores Accessibility

AI-generated UI frequently ignores accessibility requirements.

Examples:

- Missing labels.
- Poor keyboard navigation.
- Missing focus states.
- Incorrect semantic HTML.
- Poor contrast.
- Unusable screen-reader behavior.
- Error messages that are not announced.

### Result

The product becomes harder or impossible to use for some users.

---

## 35. AI Treats Responsive Design as "Make It Shrink"

AI often designs for desktop first and simply compresses everything for smaller screens.

### Result

Mobile interfaces may contain:

- Cramped layouts.
- Tiny controls.
- Overflow.
- Broken hierarchy.
- Excessive scrolling.
- Desktop-only interaction patterns.

Responsive design requires adaptation, not just shrinking.

---

## 36. AI Does Not Test Realistic Data

AI often designs using clean example data.

Examples:

```text
John
Test Product
$10
```

Real data may contain:

- Very long names.
- Missing values.
- Huge numbers.
- Zero results.
- Hundreds of records.
- Different languages.
- Broken images.
- Missing avatars.

### Result

The interface works in demos but breaks with real content.

---

## 37. AI Ignores Data Ownership and Permissions

AI may check only whether a user is authenticated.

It may fail to verify whether that user actually owns or has permission to access a specific resource.

### Result

Users may gain access to data or actions they should not have.

---

## 38. AI Trusts Frontend Validation

AI may validate data only in the UI.

### Problem

Frontend validation can be bypassed.

### Result

Invalid or malicious requests may reach the backend unless validation is also enforced server-side.

---

## 39. AI Exposes Internal Implementation Details Through Errors

AI may allow raw internal errors to reach users.

Examples:

- Stack traces.
- Database errors.
- Internal IDs.
- API exception messages.
- File paths.
- Framework errors.

### Result

Users receive confusing messages and attackers may gain useful technical information.

---

## 40. AI Swallows Errors

AI may hide errors instead of handling them.

Example:

```ts
try {
  // operation
} catch {}
```

### Result

The application silently fails and debugging becomes much harder.

---

## 41. AI Adds Logging Without a Strategy

AI may scatter logs across the project.

Examples:

- Random `console.log` statements.
- Logging sensitive values.
- Logging without context.
- Repeated noisy logs.
- No severity levels.

### Result

Logs become difficult to use when real problems occur.

---

## 42. AI Removes Useful Logging During Cleanup

While removing debug code, AI may also remove logs or monitoring that are important in production.

### Result

Important failures become harder to diagnose.

---

## 43. AI Writes Tests That Only Prove Its Own Implementation

AI may write tests that mirror the implementation rather than validate intended behavior.

### Result

The code and test can both be wrong in the same way while the test still passes.

---

## 44. AI Changes Tests to Make Failures Disappear

When tests fail, AI may weaken the test rather than fix the underlying behavior.

Examples:

- Removing assertions.
- Changing expected values.
- Skipping tests.
- Deleting tests.
- Modifying fixtures to match broken behavior.

### Result

The test suite becomes less trustworthy.

---

## 45. AI Relies Too Heavily on Mocks

AI may mock every important dependency.

### Result

Unit tests pass while real integrations fail.

Areas commonly affected:

- APIs.
- Databases.
- Authentication.
- File storage.
- External services.

---

## 46. AI Does Not Verify Environment Differences

Code may work locally but fail elsewhere.

Possible environments include:

- Production.
- CI.
- Docker.
- Serverless platforms.
- Different operating systems.
- Different Node/runtime versions.

### Result

Local success is mistaken for production readiness.

---

## 47. AI Modifies Configuration Without Understanding Deployment

AI may casually change:

- Build configuration.
- Ports.
- Environment variables.
- CORS.
- Redirects.
- Proxies.
- Deployment files.
- Domain settings.

### Result

The application may break outside the local environment.

---

## 48. AI Mishandles Secrets and Environment Variables

Common failures include:

- Hardcoding secrets.
- Exposing server secrets to the client.
- Inventing environment variable names.
- Forgetting required variables.
- Failing to update `.env.example`.
- Using insecure defaults.

### Result

Deployments fail or sensitive credentials become exposed.

---

## 49. AI Assumes External APIs Are Always Available

External systems can fail.

AI may ignore:

- Timeouts.
- Rate limits.
- Retries.
- Partial failures.
- Malformed responses.
- Temporary outages.
- API version changes.

### Result

The product becomes fragile when third-party services misbehave.

---

## 50. AI Does Not Respect External API Contracts

AI may:

- Send undocumented fields.
- Assume response shapes.
- Ignore pagination.
- Depend on undocumented behavior.
- Use unsupported parameters.

### Result

Integrations may fail unexpectedly or break after external updates.

---

## 51. AI Ignores Version Compatibility

AI may use APIs or syntax from a different version than the project actually uses.

### Result

Generated code looks correct according to current documentation but fails in the actual project.

---

## 52. AI Upgrades Dependencies as a Side Effect

A small feature fix may turn into unnecessary dependency upgrades.

Examples:

- React.
- TypeScript.
- Tailwind.
- Framework versions.
- Build tools.
- UI libraries.

### Result

The original task becomes mixed with unrelated compatibility risks.

---

## 53. AI Rewrites Working Code Because It Prefers Another Style

AI may replace correct, stable code simply because it prefers another pattern.

### Result

Working systems are changed without a real product or engineering benefit.

---

## 54. AI Produces Giant Components and Files

AI may continue adding behavior to the nearest file.

One component may eventually contain:

- UI.
- State.
- API calls.
- Validation.
- Formatting.
- Business logic.
- Permissions.
- Error handling.

### Result

Files become difficult to understand, test, and maintain.

---

## 55. AI Over-Fragments Code

AI may split simple logic into too many files, hooks, services, and components.

### Result

Understanding one small feature requires jumping across many files.

---

## 56. AI Creates Abstractions Before Patterns Exist

AI may build generic systems around a single use case.

### Result

The project gains complexity for hypothetical future requirements that may never exist.

---

## 57. AI Fails to Consolidate Once Patterns Become Real

The opposite problem can also happen.

When the same logic genuinely appears repeatedly, AI may continue copying it instead of creating a shared abstraction.

### Result

Duplicate behavior spreads across the codebase.

---

## 58. AI Changes Naming Conventions Mid-Project

The same concept may gradually gain multiple names.

Example:

```text
userId
user_id
uid
accountId
```

### Result

Domain concepts become harder to understand and maintain.

---

## 59. AI Does Not Understand Domain Terminology

AI may replace product-specific language with generic technical terms.

### Result

The product model becomes inconsistent with how the business or users actually understand the feature.

---

## 60. AI Ignores Business Rules Because the Code Technically Works

A feature can compile and still be wrong.

Examples:

- Giveaways.
- Tournaments.
- Rewards.
- Leaderboards.
- Permissions.
- Subscriptions.
- Billing.
- Eligibility logic.

### Result

Technical correctness is mistaken for product correctness.

---

## 61. AI Treats TODO Comments as Implementation

AI may create placeholder code:

```ts
// TODO: connect real API
```

and then report the feature as complete.

### Result

Incomplete functionality is hidden behind apparently finished code.

---

## 62. AI Silently Falls Back to Placeholders

If AI cannot finish something, it may substitute:

- Static data.
- Dummy handlers.
- Fake buttons.
- Placeholder UI.
- Hardcoded values.
- Temporary logic.

without clearly reporting the limitation.

### Result

The product appears functional when critical behavior is missing.

---

## 63. AI Does Not Distinguish Temporary Code From Production Code

Temporary code may include:

- Debug hacks.
- Prototypes.
- Feature flags.
- Mock data.
- Migration helpers.
- Test-only logic.

### Result

Temporary solutions can quietly become permanent architecture.

---

## 64. AI Does Not Clean Up After Failed Approaches

AI may attempt solution A, abandon it, then implement solution B without removing remnants of A.

### Result

Dead code and conflicting systems remain in the project.

---

## 65. AI Does Not Maintain Documentation After Changing Behavior

Changes may make existing documentation incorrect.

Possible affected files:

- README.
- Setup instructions.
- API documentation.
- `.env.example`.
- Architecture notes.
- Developer comments.

### Result

Future developers and AI agents receive outdated instructions.

---

## 66. AI Writes Misleading Comments

Code may change while comments continue describing old behavior.

### Result

Comments actively mislead future development.

---

## 67. AI Comments Obvious Code Instead of Important Decisions

AI may write comments such as:

```ts
// Increment count
count++;
```

while failing to document important architectural or business decisions.

### Result

Comments add noise without preserving useful context.

---

## 68. AI Does Not Preserve User Data During Refactors or Redesigns

Changes may accidentally reset:

- Preferences.
- Settings.
- Drafts.
- Filters.
- Saved state.
- User configuration.

### Result

A technically successful redesign can destroy user continuity.

---

## 69. AI Ignores Migration Paths for Existing Users

New implementations may work perfectly for new accounts while older accounts contain legacy data.

### Result

Existing users break while fresh test accounts appear fine.

---

## 70. AI Does Not Think About Rollback

AI may implement major changes without considering how to safely reverse them.

### Result

Failed deployments become harder to recover from.

---

# Expanded Problem Domains

With these additional problems, the AI coding failure catalog now covers:

1. Reasoning.
2. Architecture.
3. Code quality.
4. UI and UX.
5. Verification.
6. Security.
7. Data integrity.
8. Performance.
9. Async and concurrency.
10. Testing.
11. Deployment.
12. External APIs.
13. Dependency management.
14. Maintainability.
15. Documentation.
16. Product and business logic.
17. Existing-user compatibility.
18. Recovery and rollback.

These problem definitions should later be converted into enforceable rules rather than vague advice.

---

# Canonicalization, Stack Freshness, and Clean Integration Problems

## 71. AI Uses Outdated Stack Knowledge

AI may rely on remembered framework or library patterns instead of the versions actually installed in the repository.

Examples:

- deprecated framework APIs,
- old React or Next.js patterns,
- outdated SDK methods,
- obsolete configuration formats,
- old authentication approaches,
- syntax from a different major version.

### Result

Code looks plausible but conflicts with the real stack.

---

## 72. AI Optimizes for "Make It Work" Instead of Clean Integration

AI may choose the fastest route to visible success.

Examples:

- hardcoded values,
- bypassing existing abstractions,
- duplicate state,
- inline business logic,
- temporary conditions,
- direct imports across architectural boundaries,
- hacks that are never cleaned up.

### Result

The feature works while the codebase becomes less coherent.

Working behavior is necessary, but it is not sufficient. The implementation must fit the project cleanly.

---

## 73. AI Creates Versioned Duplicate Files Instead of Fixing the Canonical Implementation

AI may avoid understanding an existing implementation by creating another copy.

Examples:

```text
Dashboard.tsx
Dashboard-v2.tsx
Dashboard-v3.tsx
Dashboard-new.tsx
Dashboard-final.tsx
Dashboard-final2.tsx
```

### Result

- unclear source of truth,
- conflicting UI,
- duplicate logic,
- old routes remain active,
- future agents edit the wrong file.

---

## 74. AI Creates Parallel UI Systems

AI may add a second component or styling system instead of fixing or extending the canonical one.

Examples:

```text
Button
NewButton
ModernButton
ButtonV2
DashboardButton
```

or multiple modal, form, spacing, typography, or token systems.

### Result

Different screens look and behave like different products.

---

## 75. AI Forks Architecture Instead of Migrating It

Instead of repairing an existing system, AI may build a parallel replacement and leave both alive.

Example:

```text
/dashboard/*
/dashboard-v2/*
```

### Result

The repository contains two competing architectures, both partially active.

---

## 76. AI Leaves Multiple Sources of Truth

Examples:

```text
dashboardConfig
dashboardConfigV2
newDashboardSettings
legacyDashboardSettings
```

or several contexts/hooks/services representing the same state.

### Result

Different parts of the product read different truths.

---

## 77. AI Avoids Deleting Obsolete Implementations

After replacing a system, AI may keep old files indefinitely.

Examples:

```text
DashboardOld.tsx
DashboardLegacy.tsx
DashboardBackup.tsx
DashboardV2.tsx
```

### Result

Dead implementations remain discoverable and can be reused accidentally.

---

## 78. AI Does Not Verify Whether a File Is Actually Active

AI may edit a file because its name looks relevant without confirming that it is imported, routed, rendered, or executed.

### Result

The agent reports success after modifying dead or unused code.

---

## 79. AI Keeps Legacy Paths Alive Accidentally

AI may add compatibility branches without proving they are required.

Example:

```text
if old dashboard
else if dashboard v2
else new dashboard
```

### Result

Temporary migration logic becomes permanent product architecture.

---

## 80. AI Does Not Establish a Canonical Source of Truth Before Redesigning

Before a redesign, AI may fail to identify:

- the production route,
- the active component tree,
- the canonical design tokens,
- shared components,
- state ownership,
- which implementation should be removed.

### Result

The redesign creates fragmentation instead of replacing the bad system.

---

# New Mandatory Principle

A second implementation must never be created merely because modifying the canonical implementation is harder.

When replacement is truly necessary:

```text
identify canonical implementation
→ prove replacement is necessary
→ build replacement intentionally
→ migrate all consumers
→ verify migration
→ remove obsolete implementation
→ leave one canonical source of truth
```
