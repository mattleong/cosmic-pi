# Shared tool presentation

This contract applies to workspace-owned visible tools. Code Previews owns shell policy and composition; each tool package owns domain classification and unique content. Rendering must preserve execution, permissions, result content, retained evidence, and native images. Headless tools and command/settings interfaces do not need the tool shell.

## Registration and policy

Use `withCodePreviewShell` for executable definitions owned by the extension, and declare `pi-code-previews` as a runtime dependency. When project settings apply, call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())` inside `session_start` before wrapping and registering. Wrapping captures collapsed style and background mode. Renderer-only integrations use `withCodePreviewRenderers`; never wrap another extension's execution definition.

For tools registered during `session_start`, install `registerCodePreviewReplay` at factory time, anchored to the extension's unique command. Wrap through its `shell`, publish only after successful tool registration, call `finishStartup` when startup settles, and `retire` on shutdown. Exact public tool/command source identity controls adoption. History reconstructed before startup keeps its retained call/result content and fixed self shell, then adopts only its originating first-ready owner's appearance. Replay never executes tools or changes activation, and old rows never borrow replacement settings or schedulers. Historical custom-message renderers also register at factory time without restoring delivery authority.

Code Previews requires Pi 1.0.1 or later and is tested with 1.2.0. One stable factory-time `pi.registerToolRenderer` resolver uses only public renderer fields from `next()`. Exact builtin metadata admits native presentation. Explicit third-party adapters use separate exact package/source/name admission; unsupported or ambiguous ownership falls through. No native factory interception, manager replacement, private execution lookup, forced takeover, or configuration mutation is permitted. Write's actual before-write snapshot hook is the sole exception to presentation-only registration and preserves native mutation-queue and activation semantics; see [Pi boundaries](pi-boundaries.md#tool-and-native-manager-integration).

`CompactSummary` describes action, subject, counters, metadata, outcome, issues, and optional children. Settled summaries explicitly classify domain outcomes or neutral `returned` delivery. Transport success and a false Pi error flag do not prove domain success. Keep cancellation, uncertainty, delivery failure, and cleanup blockers distinct. `resolveCompactSummary` reconciles host errors; `planCompactPresentation` supplies conservative fallback for absent or malformed summaries. Neither infers domain semantics from rendered text.

A parent's outcome is its own. Children can contribute attention without turning a handled failure into a second parent error. Green checks indicate semantic success; neutral returns remain neutral even where native Code Mode uses `returnedCheckmark` for completed dispatches. Unknown outcomes never become success by default.

Collapsed calls have one semantic heading and at most one routine detail. Counters precede metadata and measured timing; the call's issues follow. Call trees show at most five children, prioritizing active/problem calls and accounting for hidden failures. All retained children contribute attention before selection. Counters and omission counts must not lose digits or failure evidence at narrow widths. Missing or incomplete summaries preserve an expansion path rather than presenting a speculative success card.

Native presentation adds these evidence constraints:

- `tool_search` requires exact `builtin:tool-search` ownership. Bounded `details.loaded` receipts support neutral listing counts, not claims about current availability. Rendering never discovers or activates tools.
- Codemode inspects only the latest 256 call slots, validates neighbors independently, and retains coverage uncertainty when records are missing or rejected. Listed records are not inferred dispatch totals; settled `running` records remain unconfirmed. Expansion preserves bounded receipts and diagnostics without reading persisted artifacts.
- Parsed program source can supply discovery intent, never execution receipts. Recognize direct unshadowed helpers only; require explicit static MCP targets/namespace filters for MCP specificity. Inert text, unused bodies, aliases, dynamic callees, unsupported source, and exhausted budgets decline. Do not synthesize children or infer discovery from guest output.
- MCP names and observed argument scalars support readable labels only when unambiguous. Never expand hashes or ambiguous aliases into guessed remote identities. Standalone MCP admission is independent of builtin/codemode preview selection; historical aliases require an independently builtin-owned `/mcp` manager. Pi retains all manager, execution, authentication, exposure, and image ownership.

Native source previews retain an eight-wrapped-row bound, including theme fallback, and expose full source on expansion. Timing is measured only: parent duration is not the sum of concurrent children, and replay without an observed start stays untimed. Normal timing appears after `TIMING_VISIBLE_MS`; native `showShortTiming` can expose measured subsecond values. `animateProgress` is opt-in and independent of timing. Scheduling always belongs to the registering session and stops on retirement. See [integration APIs](../../packages/pi-code-previews/docs/extension-authors.md) and [native behavior](../../packages/pi-code-previews/docs/reference.md).

## Issues

`CompactIssue` is `{ severity, code, message, detail? }`. Errors and warnings show the same short human-facing `message` collapsed and expanded. Agent procedures, retry instructions, tool-call syntax, internal IDs, and raw diagnostics belong in expanded-only `detail`. Routine information, including pagination and usable saved-output locations, appears only when expanded. Equal code/severity/message entries merge while retaining distinct detail lines.

Producers own classification and wording:

- Name the subject and specific event, avoiding repeated category labels, error-class prefixes, internal type names, and trailing periods.
- Prefer the actual warning or question over saying one exists, unless the quoted text is an instruction to the agent.
- Use severity for attention the user needs; routine stops and changes awaiting ordinary review are metadata or information.
- Add at most one short, redacted cause when status alone does not explain failure. Aim for about 70 characters; messages wrap rather than disappear through clipping.

Use `failureMessage(text, fallback)` for unclassified failures and `firstLineMessage(text, fallback)` for other text. They sanitize and bound the first nonblank line; `isAgentGuidance` detects leading procedures. Full raw evidence remains in agent-facing results and expansion. `compactSubject` changes compact labels only.

Render all issues through `renderCompactIssues`, including nested and asynchronous consumers. Both appearance styles use the same issues in the same words. Producers check messages with `issueMessageStyleProblems` rather than exact-copy assertions.

Output clipping is informational only when bounded native metadata supplies a usable saved-output path. Missing recovery and save failures remain warnings. Standalone MCP preview may replace only a recognized, owned, non-error saved-output envelope with a neutral expansion affordance. Extra text, contradictory errors, unknown envelopes, and progress retain original behavior. Full envelopes and recovery paths remain expanded; a path does not establish that the artifact still exists or that the agent read it. Rendering never reads spill files.

## Expanded composition

`expandedContent.renderCall` and `expandedContent.renderResult` use the original signatures and return unique content without a second heading or issue list. An empty `Container` intentionally contributes no content; an omitted callback preserves the original slot.

For valid summaries, compact expansion composes the shared heading, issues with details, unique call content, then unique result content. Missing or malformed summaries retain original renderers. Preserve complete arguments, source, commands, proposed edits, output, and recovery instructions, including after failure. Do not subtract evidence merely because an issue repeats it; label raw content or agent notes instead. Input that the heading cannot show exactly remains available in full.

Original and content-only callbacks keep independent call/result `lastComponent` caches. Retained components capture needed values and renderer state, not the render context whose prior component would chain history. Preserve existing invalidation, mouse routing, live panels, and owner-scoped animation. Construction or drawing failure restores safe raw-result fallback without replaying the failing renderer. External adapters preserve opaque downstream components and append complete arguments/raw evidence when the provider's expansion may clip them. Pi retains native images and transcript separators.

## Preview style

Preview is the default. It retains tool call/result bodies and inserts shared issues between them. A call body containing a diff or proposed file places `previewIssuesSlot(context)` beneath its heading. Argument-derived warnings remain visible before execution or approval. A failed theme falls back to plain messages.

Tool renderers provide a human heading via `renderToolHeader`, bounded collapsed content, and complete expanded content. They do not draw duplicate issue/outcome lines or expose operation IDs as display labels. Use `toolRunningLine` when pending work has no other content, and `renderExpansionAffordance` with configured key hints. Never hard-code the expansion shortcut.

## Shared vocabulary

Use Cosmic Core's duration, count, size, cost, timestamp, path, and text formatting helpers and Cosmic UI's `clipToWidth` and `managerActivity*` helpers. Their implementations own glyphs, tones, clipping, and spinner cadence. Preserve the distinction between a cancelled request and stopped running work; green denotes success, while waiting/paused work needs attention.

## Messages outside tool rows

Notifications, replies, and confirmations use short human-facing wording without internal IDs or agent procedures. `notifyAtHostBoundary` normalizes one-line messages and preserves deliberate multi-line reports; raw failures pass through `failureMessage`. Describe what failed and, when known, why. Successful actions use a short past-tense statement. Confirmations name the item by its display name.

## Managers and settings commands

Use the shared Cosmic UI manager navigation, action vocabulary, confirmation behavior, and settings command shell. Disruptive manager actions ask for the same key again and allow cancellation. `registerExtensionCommand` owns routing and completion; settings use `/<extension> settings` with help, status, scope, and assignment support. Preserve existing public commands, native `/mcp` grammar, and feature-owned manager fallback when the Activity host is unavailable. The [UI integration guide](../../packages/pi-cosmic-ui/docs/extension-authors.md) describes these APIs without duplicating their implementation here.

## Retention and validation

Bound and sanitize evidence where it enters a package or persistence boundary. `createBoundedCompactIssuesSchema` provides bounded issue schemas. Redact before storage, mark incomplete evidence, and do not raise retention limits merely to make rendering pass. Changed versioned receipts need an explicit version change; unsupported versions decline to generic presentation.

Use `pi-code-previews/testing` with actual registered definitions or public renderer-only callbacks. `createToolPresentationHarness` exercises call/result slots, widths, expansion, lifecycle, and invalidation without executing tools. Host-row helpers cover Pi's retained history, first-ready adoption, complete reconstruction, owner retirement, and fallback. Avoid importing another package's internal source for consumer assertions.

Behavioral coverage protects fallback, uncertainty, issue merging, source/recovery preservation, native images, renderer failures, and unchanged execution/result objects. Visual wording and layout are reviewed with `pnpm presentation:gallery`; add a scenario to the package's env-gated `tests/presentation-gallery.test.ts` when adding a visible state. The gitignored gallery is a review artifact, not an exact-text test oracle.

Each package's `ARCHITECTURE.md` identifies its visible tools and ownership. Supported external renderers have a separate [adapter maintenance guide](../../packages/pi-code-previews/docs/third-party-renderers.md); their domain behavior and execution remain outside workspace ownership.
