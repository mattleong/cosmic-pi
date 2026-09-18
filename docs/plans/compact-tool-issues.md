# One issue block for compact tool previews

Status: implementation complete except invocation attribution for propagated root failures. Shared producers and bounded Code Mode v2 receipts now project structured issues. Workspace validation passed, including packaging and source-loading smoke tests.

## Goal

A collapsed tool call has at most one issue block, styled as either an error or a warning. It states the specific cause once and keeps essential recovery guidance visible. Successful calls remain one line unless they have child calls. Expansion retains full diagnostics.

One block does not mean one sentence or one cause for an entire batch. Independent failures retain their operation identities within the same block.

## Classification

Execution outcome and display severity are separate facts.

- Error: explicit tool failure, rejected execution, or an established required-output validation failure.
- Warning: uncertain execution without a known failure, incomplete usable output, unavailable validation, or unconfirmed cleanup.
- No issue: completed without actionable attention. Routine metadata, cache notices and ordinary pagination stay expanded unless action is required.
- Cancellation alone remains cancellation, not an error. Uncertain side effects or cleanup still require a warning.
- Error wins the block color when both severities exist. It never removes execution uncertainty, partial success, or recovery restrictions.

The shared layer never searches arbitrary output for words such as "error" or "warning". Producers interpret their own typed results. Pi's error flag is a failure signal, not proof that remote work did not execute.

## Contract and ownership

Add a structured issue collection to compact summaries and child summaries. Each issue carries:

- A producer-owned semantic code and operation/invocation identity.
- Severity, a specific cause, and an explicit ordered list of essential recovery instructions.
- Optional classified secondary diagnostics for expansion.
- Coverage evidence indicating whether collapsed presentation preserves all attention and recovery.

Use semantic identities for causes and recovery instructions. Do not deduplicate by substring, text similarity, or model inference. Equivalent identified evidence can coalesce; conflicting evidence with the same identity remains visible. Unclassified legacy text is not silently discarded.

`pi-code-previews` owns normalization, severity precedence, deduplication and rendering. Producers own classification, primary-cause priority, sanitization and recovery order. Code Mode owns receipt bounds, invocation attribution and completeness. No display contract grants retry, cleanup or execution authority.

Keep existing fields through a compatibility adapter during migration. Unknown or malformed historical results and providers that throw continue to use the original safe renderer. Incomplete evidence cannot opt into a shorter presentation that conceals recovery.

## Presentation

- One status header and one issue container, not separate red and yellow blocks.
- Specific causes replace redundant generic labels where typed evidence proves equivalence.
- Essential recovery wraps without horizontal truncation. Only producer-classified secondary diagnostics move behind expansion.
- A batch can list multiple attributed causes within its single issue block.
- For Code Mode, child rows retain status markers, but the outer call owns one consolidated issue block. Visible and omitted children contribute equally to attention. Parent propagation of an identified child failure is shown once; independent guest-delivery failures remain distinct.
- Expansion preserves original details and images. Ownership suppression applies only after the original renderer succeeds; renderer failure must not hide shell-owned recovery.

Example:

```text
✗ mcp tools.call chrome-devtools / click
  Element is no longer attached to the page.
```

An uncertain failure must retain the restriction:

```text
✗ mcp tools.call server / operation
  Request timed out; the operation may have completed.
  Inspect its state before retrying.
```

Examples illustrate structure, not instructions inferred by the renderer. Actual recovery comes from producer evidence.

## Implementation sequence

### 1. Shared issue contract and reducer

Primary files:

- `packages/pi-code-previews/src/tools/compact-summary.ts`
- New `src/tools/compact-issues.ts`
- New `src/preview/compact-issues.ts`
- `src/preview/compact-{shell,tool-call,row,children}.ts`

Separate visible severity from `CompactOutcome`. Replace failure-body substring suppression with explicit evidence identity. Adapt legacy notices conservatively into one container. Preserve shell modes, timing, wrapping, expansion and fallback.

### 2. Built-in tools

Migrate `builtin-failure.ts`, `builtin-projection.ts` and `compact-notices.ts`. Reuse recognized failure categories and existing coverage evidence. Keep unfamiliar output and attachment failures on their conservative paths. Do not shorten arbitrary diagnostics to their first line.

### 3. MCP

Migrate producer interpretation in `code-mode/presentation.ts`, then `ui/compact-summary.ts` and card decoding/rendering.

Preserve these distinctions:

- Remote failure versus local result retrieval failure.
- Completed execution versus output validation mismatch.
- Unavailable validation versus proven invalid output.
- Unknown execution versus confirmed non-dispatch.
- Original retained operation failure versus successful reading of that output.

Retain the recent fix exposing sanitized remote errors while collapsed. Enable compact failure ownership only when attention and recovery coverage is established. Do not replace specific remote error text with a generic category.

### 4. Other standalone producers

Migrate Background Tasks, Subagents, Ask User and Better OpenAI images.

- Task exit failures, timeouts, lost output and cleanup uncertainty remain distinct evidence.
- Subagent partial starts, claim containment, workspace requirements and cleanup gates retain ordered recovery.
- Questionnaire cancellation remains distinct from failure.
- Image failures retain diagnostics and native-image behavior.

### 5. Nested Code Mode

Carry structured issues through bounded receipts and adapters. Use an explicitly versioned schema change when required; continue decoding existing v1 history.

Do not retain arbitrary full diagnostic bodies in child receipts. Preserve invocation identities, limits, overflow evidence, omitted-child attention and original remote outcomes after guest delivery failure. Remove presentation-time text deduplication from producer aggregators once the shared reducer owns it.

### 6. Documentation and final review

Update affected package architecture documents and the compact-preview design record. Review every registered summary provider, including nested subagent and parent-contact paths. Confirm ordinary tool results, execution, permissions, retention and native images are unchanged.

## Acceptance tests

Test domain projection and preserved information, not exact colors, icons or layout snapshots.

- One normalized issue container per collapsed call.
- Error plus warning uses error severity while preserving both essential facts.
- Uncertainty and unconfirmed cleanup survive a concurrent known error.
- Matching semantic identities deduplicate; different invocations with identical prose remain attributable; conflicts are not suppressed.
- Specific MCP error text remains visible in compact fallback and structured paths.
- Retained reads do not rewrite the original outcome or imply replay is safe.
- Cancellation does not become an error without independent failure evidence.
- Partial batches and omitted nested children retain attention and ordered recovery.
- Historical, hostile, malformed, oversized or incomplete evidence cannot become false success or silently lose warnings.
- Expansion retains diagnostics; original-renderer failure preserves recovery.
- Standalone and nested operations classify equivalent evidence consistently.
- Model-facing results and source objects are unchanged.

Run affected package tests and checks after each migration, then `pnpm validate` and packaging smoke. Review representative standalone and nested examples at narrow and wide widths.

## Non-goals

No execution-policy changes, retries, new authentication behavior, full-screen UI changes, text-based severity guessing, LLM summarization, or suppression of unknown recovery guidance merely to shorten a card.

## Implementation notes

Code Mode retains explicit v1 history decoding and emits v2 receipts and aggregates. Each collection
has at most 32 issues, with eight recovery instructions per issue and 1024 UTF-16 units per string.
Every child issue receives its invocation prefix before aggregation. Delivery failures keep their own
identity and do not rewrite the captured operation outcome. The parent combines aggregate and
retained-child evidence before selecting visible rows. Overflow retains an incomplete-evidence
warning and the no-replay restriction. Background Tasks adds optional bounded issues to its existing
v1 presentation callback; its execution capability and guest result protocol are unchanged.

The registration audit covers built-ins, MCP, Background Tasks, synchronous and async Ask User,
images, Subagents tools, supervisor parent tools, and child `contact_parent`. No execution,
permissions, retention, or native image path changed.

Three shared-shell review fixes accompany the migration. Aggregate child coverage gates shortened
presentation. Pi failure evidence cannot be hidden by a success summary with a failure body, and
synthesized error severity retains execution uncertainty. A component whose render method throws
loses its cached ownership before invalidation or subsequent renderer reuse.

One limitation remains. Historical and current root failure provenance records tool/category/cause,
not an invocation ID. Code Mode no longer suppresses that root explanation by matching child prose.
Ambiguous propagated failures can therefore appear twice, rather than merging independent calls.
A future change needs runtime-origin invocation provenance before that case can safely coalesce.
Legacy unclassified copies also remain visible because text equality is not identity.

Validation: affected Code Mode, Code Previews, and Background Tasks tests and typechecks passed.
`pnpm validate` passed with 5,227 workspace package tests and three existing skipped tests,
plus anti-slop rule tests, architecture/version checks, Effect diagnostics, lint, formatting,
and clean-consumer packaging/Jiti smoke. Narrow and wide rendering regressions cover attention
wrapping, hidden children, original-renderer fallback, and expanded recovery.
