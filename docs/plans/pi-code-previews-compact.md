# Compact collapsed tool calls

Status: implemented. Compact rendering remains opt-in and requires `/reload` after changing the setting.

## Decisions

- Compact rendering is opt-in.
- Compact rendering applies while arguments stream, while execution runs, and after completion.
- Ordinary live output and pending write/edit previews stay hidden until expanded.
- Errors, warnings, and recovery instructions remain visible while collapsed.
- Pi's host-owned blank separator stays. This work does not group calls or change execution.

## Display behavior

An ordinary collapsed tool uses one text row containing state, tool name, subject, and optional elapsed duration. A small inline indicator makes hidden details discoverable. There is no border, timing footer, separate expand-hint row, or redundant success row.

Illustrative rows, not fixed copy or icons:

```text
· read src/application.ts · waiting
↻ bash pnpm test · 1.2s
✓ write src/config/schema.ts · 127ms
```

States:

| State                                     | Collapsed behavior                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Arguments arriving or waiting to execute  | One row with available subject and pending state; no execution duration |
| Executing or streaming ordinary output    | One row with running state and measured elapsed time                    |
| Completed successfully                    | One row with final summary and measured duration, if available          |
| Warning or recovery notice                | Keep the notice visible, even if extra rows are needed                  |
| Failed, cancelled, or execution uncertain | Preserve error/recovery detail; never claim success                     |
| Expanded                                  | Show the existing detailed call/result presentation                     |
| Restored session                          | Show recorded outcome, but do not invent an execution duration          |

A long subject truncates rather than wraps. Preserve the status and tool identity before optional metadata; drop optional metadata when space is scarce. Sanitize control characters and multiline subjects, and use terminal-width-aware helpers for Unicode and ANSI styling.

Native images are an exception to the total row budget. Pi renders them outside the extension's call/result components. Preserve image behavior rather than removing content from tool results.

### Failure presentation

Known failures use one compact header and an indented cause. There is no collapsed border or duplicate original error card. Explicit `failure: { cause, details }` ownership replaces both original slots; expansion shows complete error text once inside the selected background/frame. Independent warnings and recovery notices remain visible. Cancellation is neutral and uncertainty amber. Unknown error wording stays intact rather than losing possible recovery instructions.

## Configuration

Add a separate setting rather than another background mode:

```json
{
  "toolCallCollapsedStyle": "compact"
}
```

- Values: `preview` and `compact`.
- Default: `preview`, preserving existing installations.
- Environment default: `CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE=compact`.
- Expose the setting in `/code-preview-settings`.
- Capture it at tool wrapping/registration time; changes require `/reload`.
- Keep `toolCallBackground` and `toolCallTiming` independent.
- In compact mode, timing appears inline when enabled.
- Expanded and noncompact fallback rendering retain the configured background/frame.
- Compact presentation takes precedence over per-tool collapsed-preview toggles and line limits. Those settings retain their existing meaning in `preview` mode. Expansion still reveals details.
- Keep the existing settings precedence, trust checks, tolerant field recovery, and single `config/store.ts` persistence entrypoint.

## Scope and safety

First release covers installed replacements for `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`. It does not enable tools that are disabled or owned by another extension.

Expose an optional typed compact-summary provider through `withCodePreviewShell`. Cooperative tools without that provider retain their current rendering. Preserve the existing `preserveSelfShell` behavior. Explicit workspace providers now cover MCP, all 11 public subagent tools, Code Mode, background tasks, questionnaires, and image generation. Each classifies its own domain outcomes. Unknown or malformed results retain their original view. Decoded subagent and background-task outcomes opt into `detailsOnExpand`: collapsed attention and recovery notices stay visible, while reports, audits, logs, and workspace diffs stay behind expansion. Child-only text acknowledgements and parent messages remain unmodified. Loading preview settings alone does not opt a tool into semantic compaction.

Code Mode uses intent and nested-call counts, not source text. Fulfilled nested MCP/Background Tasks calls can contain domain failures that activity records do not retain, so those completed programs keep their original view rather than claim compact success.

Do not extract summaries by flattening components, taking their first line, parsing ANSI colors, or assuming `isError: false` means domain success. A successful tool invocation can report failed background work, uncertainty, or required recovery actions.

Built-in summaries must preserve:

- Bash command warnings and detected secret warnings.
- Output truncation and continuation instructions.
- Write/edit limitations such as unavailable or skipped diffs.
- Actual error/cancellation state.

Warning detection must run independently of whether preview bodies are rendered. Do not reuse early hidden-preview returns that skip these checks. Keep existing bounded scans and diff guards. Do not calculate a large diff solely to produce optional summary counts.

## Implementation sequence

### 1. Settings and semantic summary contract

Update `packages/pi-code-previews/src/config/{schema,defaults,env}.ts` and the settings registry, grouping, summaries, and health projection where applicable.

Add `src/tools/compact-summary.ts` for semantic data and policy. The provider receives current arguments, available result, and renderer context. It returns a subject, supported metadata, semantic outcome, and important notices, or declines compaction. It does not return an arbitrary rendered component.

Extend `src/tools/renderer-adapter.ts`, `src/tools/cooperative-tools.ts`, and package `index.ts` to carry this optional contract. Preserve execution, result contents, schemas, prompt metadata, and unbound renderer calls.

### 2. Compact shell and timing

Add `src/preview/compact-tool-call.ts` and integrate it through `src/preview/tool-shell.ts`.

Pi fixes `renderShell` per registered definition. Compact-capable tools therefore use `self` throughout their lifetime. Compose detailed fallback rendering locally with public TUI components: a Box for background `on`, the existing border component for `border`, and unframed content for `off`. Do not add a second transcript spacer.

Keep one shell in the call slot that the result slot can update. Retain separate original call/result components and their `lastComponent` values. Handle result-only rendering without dropping content, and avoid duplicating the result during transitions.

Reuse `src/preview/tool-timing.ts` and its scoped scheduler. Separate duration formatting from footer presentation. Pending calls have no execution timer. Settlement freezes measured duration and stops scheduling; replay omits unmeasured durations.

Do not let timing-only cache reuse hide expansion, argument, result, error, or theme changes. Invalidate based on semantic changes as well as width. Preserve independent state for concurrent tool calls.

### 3. Built-in summaries and notice extraction

Update `src/tools/renderers/{read,bash,write,edit,grep,find,ls}.ts` and shared path-list helpers as needed.

Reuse argument normalization and existing structured result information:

- Read: path and requested range.
- Bash: normalized command subject.
- Write/edit: path and inexpensive, known outcome metadata.
- Grep/find/ls: pattern or path; counts only when reliable without additional work.

Extract notice discovery from body formatting where necessary, especially `shared/secret-preview.ts`, bash warnings, truncation handling, and guarded diff outcomes. Do not parse the text generated by existing renderers.

Use lifecycle evidence to distinguish pending, running, and settled state. Replay can supply a final result without `executionStarted` or `argsComplete`; those flags must not be prerequisites for a settled summary. A pending call is not successful merely because `isError` is false.

### 4. Tests and documentation

Extend configuration, settings-controller, cooperative-tool, timing/cache, and renderer tests under `packages/pi-code-previews/tests/`.

Protect these behaviors:

- Opt-in persistence, independent invalid-field recovery, trusted-project precedence, and reset.
- Pending arguments, running without output, streaming output, success, failure, and pre-execution abort.
- Expand/collapse restores original details without missing or duplicate content.
- Warnings and continuation/recovery information survive collapsed rendering.
- Final result metadata updates the summary immediately.
- Expansion and result updates remain visible during timing invalidation.
- Restored calls do not gain fabricated durations.
- Timing stops after settlement and session cleanup.
- Concurrent calls retain independent state.
- Unknown cooperative renderers retain their bodies, including domain failures with no Pi execution error.
- Summary sanitization and width bounds preserve meaningful status on narrow terminals.

Avoid exact copy, icon, ANSI, or layout snapshots. Test semantic policy and information preservation; verify the visual row budget in TUI smoke testing.

Update `packages/pi-code-previews/README.md`, `ARCHITECTURE.md`, and the shell ownership description in `docs/architecture/pi-boundaries.md`. Include settings precedence, reload requirements, image/host-spacing exceptions, and a cooperative opt-in example.

## Validation and acceptance

Run the narrow checks first, then the full gate:

```bash
pnpm --filter pi-code-previews test
pnpm validate
```

Manually exercise normal and fullscreen TUI modes, narrow terminals, each background mode, timing on/off, expansion while streaming, pending edits, failed commands, warnings, image reads, and restored sessions.

Acceptance:

- With compact enabled, an ordinary collapsed built-in occupies one extension-rendered text row throughout its lifecycle.
- Pi's one blank separator remains, so consecutive ordinary calls occupy roughly two terminal rows each rather than the current four for a one-line bordered call.
- Expansion restores detailed output. Errors and important notices remain visible without requiring expansion.
- Leaving compact disabled preserves existing behavior.
- No tool execution, middleware, approval, tool activation, result payload, or persistence ownership changes.

## Metadata and live-header polish

- Running subagent awaits keep only their observed completion counter. Incidental tools, free-form progress, state buckets, and claims no longer change the running header. Streaming arguments and new safety notices still update immediately.
- Report availability is header metadata. Integration cautions apply to actual isolated writers, not ordinary read-only reports. An explicit, checked report-only omission marker distinguishes informational omissions from missing errors or unknown evidence.
- Background metadata drops redundant state labels and homogeneous totals. Completed images no longer repeat saved paths as recovery notices. Clean MCP retained results use metadata without repeating a requested result ID; incomplete output keeps retrieval guidance visible.
- Spinner ownership and timing remain unchanged. The subsequent width and expansion pass is described below; multiline Bash summaries remain unchanged by request.
- Actual Pi component checks passed for successive await snapshots, immediate warnings, ordinary report-only lists, omitted errors, and expanded reports in every background mode. Counter/argument updates and glyph-only ticks are also covered by regression tests.

## Width priorities and expansion cleanup

- Providers separate actions, targets, counters, and incidental metadata. Whole counters reserve space without displacing the tool/action or the minimum target budget. Short and empty targets release unused space to counters. Long targets use grapheme-safe middle elision; metadata, timing, and hints cannot force additional target clipping.
- Running counters remain current without incidental card metadata. Retry summaries retain successor IDs distinct from their requested source IDs.
- `expandedInResult` explicitly transfers a complete notice to the original expanded result. `expandedResultOwnsCall` transfers complete call-heading information, not source code or unique arguments. Both require successful construction and rendering of the current original result. Unknown results and failures at either step keep conservative fallbacks. Structured owned failures use explicit evidence ownership; unclassified legacy failures retain their notices.
- MCP opts in only for notices it already renders completely. Await result headings replace redundant call headings unless the live panel owns the result. Background logs keep their producer cursor header without a second cursor footer. Independent recovery remains inside the chosen expanded frame/background.
- Actual Pi component checks passed for all three backgrounds, narrow counters through successive streaming snapshots, repeated expansion, factory-failure recovery, final settlement, and unchanged result contents. Initial smoke-script quoting and dependency-resolution errors were corrected before the successful run.
- Final affected-package suites passed with two test workers and one package at a time: Code Previews 338, Background Tasks 145, Ask User 230, Better OpenAI 102, Subagents 1,109 with three skips, MCP 1,211, and Code Mode 149. Workspace lint, formatting, diff whitespace checks, affected-package Effect diagnostics, and packed-source/Jiti smoke checks passed. At that stage, full `pnpm validate` was blocked by the core native-context diagnostic noted below.
- Screenshot follow-up: ordinary read-range and explicitly identified line-pagination continuations no longer produce compact warnings; original output and expanded continuations remain intact. Byte caps, oversized lines, unknown truncation, and secret warnings remain visible. Clean exited log retrieval no longer warns about contractually absent exit codes. It reports retrieval success only; status checks, failed/stopping tasks, output loss, and log truncation retain their existing classification.
- Multiline Bash command summarization was explicitly skipped. No execution, scheduler, settings, native-image, or host-separator changes were made in this pass.

## Routine information follow-up

- Search caps use whole priority counters without claiming a total or the number of results surviving byte truncation. Actual output cuts, partial grep lines, and secret warnings remain visible.
- Known write-preview size and complexity guards use quiet metadata. Missing or unclassified previous-file evidence still warns; expansion and model-facing write results are unchanged.
- Successful integration receipts and workspace-list pagination use metadata. Only explicitly empty lists omit generic orphan guidance. Clean terminal static candidate skips can become a count; actual fallback warnings, missing evidence, and recovery gates remain visible.
- Model discovery counts static eligible options, disabled profiles, and unavailable profiles. Eligible alternatives do not produce per-candidate warnings. Invalid sources cannot advertise eligible options, and requested profile identity remains visible.
- Valid MCP next-page replies use ordinary retained-result metadata. Real cuts and short pages without continuation evidence retain recovery. Exact owned validation messages consolidate by validation identity only with coherent completed origin evidence. Original producer strings, remote notices, and retained results are unchanged; contradictory or unknown evidence stays conservative.
- Actual Pi components passed 18 read-only/render-only cases across all three backgrounds, covering capped search, skipped diffs, empty workspace lists, model alternatives, MCP pagination, and complete validation-warning deduplication. Rendering preserved result contents and did not execute writes, MCP calls, or subagents.

## Implementation verification

- Code Previews package tests: 330 passed across 40 files.
- Screenshot follow-up: subagent pause/claims/workspace/list/await and background logs/stops now compact decoded outcomes. Warnings use the same `╰─` indentation as error causes. Tests cover target-only completion counts, neutral cancellation, quarantine recovery gates, complete notices, and original expansion. Questionnaire overlay placement is unchanged. Actual Pi component checks passed all eight screenshot scenarios across three background modes. The final background-task suite passed 143 tests; the subagent suite passed 1,104 tests with three skips using two workers, avoiding the default-concurrency process timeout.
- Cooperative hosts now inject their own session-scoped scheduler. Regression coverage includes no local previews capability, timing on/off, preview-style timing, declined scheduling, replacement, and shutdown. An actual Pi component under an isolated Jiti loader produced four repaint callbacks and five distinct icon frames over 450 ms, then stopped on owner shutdown.
- The failure view was smoke-tested through Pi's actual tool component for read and bash in every background mode: two collapsed text rows, full error once expanded, stable repeated expansion.
- Review regressions cover wide-character preservation in narrow failure rows. The later structured-issue work replaces CRLF/substring suppression with explicit semantic identity; unidentified legacy recovery remains visible.
- Added semantic opt-ins for all six workspace consumers. Package suites passed for Code Mode, MCP, questionnaires, background tasks, and image generation. The combined subagent run hit the existing process-transport timeout; the affected process test and compact tests passed in a focused rerun.
- Code Mode rejects malformed totals and keeps opaque nested adapter results in their original view. Host callbacks retire original Code Mode/subagent tickers when compact rendering hides them; Code Mode tests and an actual Pi subagent-component smoke check cover cleanup.
- Status labels use shared icons. Effect TestClock coverage verifies running-frame changes with timing on or off, one timer across slot updates, pause/resume on expansion with timing off, and cancellation on settlement or scope cleanup.
- Package typecheck, lint, formatting, and Effect diagnostics passed. Effect diagnostics reported no errors or warnings.
- Packed-source/Jiti smoke checks and workspace lint/format checks passed.
- Smoke checks against Pi's actual tool component covered all seven built-ins, all background modes, pending/running/settled rows, narrow widths, click expansion, replay timing, complete recovery notices, and custom mouse actions/capture targets.
- Review fixes cover independent renderer-cache recovery, frame/header mouse offsets, and hidden-image fallback indicators.
- Initial `pnpm validate` runs stopped at the nested `Effect.runPromise` in `packages/pi-cosmic-core/tests/native-context.test.ts`. The separate validation fix uses `FiberHandle.makeRuntimePromise` to scope each test gate waiter, with a regression proving owner-scope cancellation leaves another gate live. Core typechecking now passes without disabling diagnostics or changing production behavior.
- Default-concurrency workspace runs encountered five-second timeouts in unchanged MCP/subagent process tests; focused reruns passed. After the core fix, the complete `VITEST_MAX_WORKERS=2 pnpm validate` gate passed, including all workspace checks, tests, and packed-source/Jiti smoke checks. No timeout, assertion, or diagnostic settings were changed.
- This verification did not launch a full interactive terminal session or visually inspect native image rendering.

## Structured issue consolidation

The shared Code Previews contract and builtin projection now support operation-scoped issues, ordered recovery, and coverage evidence. A compact outer call gathers every retained child's evidence before selecting rows and renders one issue container. Error severity dominates the container without changing execution outcome or deleting uncertainty. Matching operation/code identities consolidate; conflicts and unidentified legacy text remain visible. Provider schemas and incomplete-coverage gates preserve original fallback views. Producer migrations and bounded Code Mode v2 receipts are tracked separately in [the issue plan](compact-tool-issues.md).

Cooperative notices without explicit expanded ownership can still repeat text from original renderers. The shell preserves these conservative duplicates rather than inspecting arbitrary rendered components and risking lost recovery information.
