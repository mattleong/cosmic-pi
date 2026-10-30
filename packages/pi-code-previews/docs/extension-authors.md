# Integrating with pi-code-previews

How other Pi extensions use the Code Previews tool shell, renderer helpers, and compact summaries. The [tool presentation standard](../../../docs/architecture/tool-presentation.md) is the normative contract; this file covers the public API it doesn't spell out.

Start with the basic wrapping shown in the [README](../README.md#in-your-own-extension), and follow [registration and policy](../../../docs/architecture/tool-presentation.md#registration-and-policy) for settings capture and dependencies. With no arguments, `loadCodePreviewSettings()` reads global settings only. If a consumer only needs global settings, it may load them before initial tool registration.

Compound renderers can call `getCodePreviewToolIcon(toolName)` to reuse the same emoji as the
standalone `bash`, `read`, `write`, `edit`, `grep`, `find`, or `ls` call. Unsupported names return
`undefined`, allowing the caller to keep a neutral fallback. `getTextContent(content)` joins a
tool result's text parts with newlines, the same projection the builtin renderers use.

## Renderer-only integration

For tools registered during `session_start`, install `registerCodePreviewReplay(pi, { command, tools })` at factory time. Use its `shell` in place of `withCodePreviewShell` after trusted settings load, then `publish()` after every eligible tool is registered. Call `finishStartup()` when the first startup settles (including failure/cancellation), and `retire()` on shutdown. Continue passing the owner's token-checked animation scheduler through shell options.

`withCodePreviewRenderers({ name, label? }, renderers, options)` returns only public `renderShell`, `renderCall`, and `renderResult` callbacks. Its `selfShell` option and resolver registration follow [registration and policy](../../../docs/architecture/tool-presentation.md#registration-and-policy).

## Compact summaries

`loadCodePreviewSettings` alone does not change rendering; each integration supplies its own semantic summary.

Cooperative animation also requires `scheduleAnimation` from the registering extension's session. Pi isolates extension module instances, so loading settings cannot activate another extension's scheduler. Compose `CodePreviewSchedulerService.layer` into the owner's runtime, pass its `schedule` callback through the shell options, and reject scheduling after that session is replaced. Runtime disposal cancels every remaining animation. Built-in previews use their own scheduler by default. Native `codemode` opts into the `animateProgress` content option described in the standard. Set `animateProgress` whenever a renderer draws time-based frames, such as a spinner from `spinnerFrameAt`, unless the renderer runs its own invalidation ticker. The shell then redraws the running row every spinner frame. Without it, a preview row redraws only when its whole-second elapsed label changes, and not at all while timing is off.

Pass `compactSummary` to `withCodePreviewShell` to provide semantic action, subject, counts, metadata, outcome, and issues. The callback receives `{ phase, args, result, context }`. Outcome rules and the generic fallback are in [registration and policy](../../../docs/architecture/tool-presentation.md#registration-and-policy).

Report problems as `issues: CompactIssue[]`, following [Issues](../../../docs/architecture/tool-presentation.md#issues). Use severity `attention` for a question or decision someone is waiting on: it shows collapsed like a warning and sets the heading's status when nothing stronger applies, but it never makes the outcome a warning, never counts as success, and never explains an error result. `mergeCompactIssues` and `compactIssueSeverity` help combine and classify issue lists; `compactIssueSeverity` returns the strongest of `error`, `warning`, and `attention`. `argumentFailureIssue(text)` classifies an error result in which Pi rejected the call's arguments before the tool ran, returning `undefined` for any other text; the shell already applies it to an error result whose summary reports no error or warning, so call it first only when your summary classifies error results itself. A summary whose own error or warning issue explains an error result gets no second host issue; when no issue detail carries the host's text, the shell adds it to that warning's expanded detail. Pi parses malformed tool-call JSON as `{}` and refuses to run the call; when `isRejectedEmptyCall(context)` holds for its render context, name only the tool in the call heading rather than describing argument defaults. Supply `expandedContent: { renderCall, renderResult }` for compact expansion, following [expanded composition](../../../docs/architecture/tool-presentation.md#expanded-composition).

`pi-code-previews/testing` exports `createToolPresentationHarness(toolOrRenderers, { theme?, width?, state?, cwd? })`; see [retention and validation](../../../docs/architecture/tool-presentation.md#retention-and-validation) for it, the other testing helpers, and `createBoundedCompactIssuesSchema`.

This example assumes `reportTool` takes a `path` argument. Its domain contract puts every warning in `details.warnings`, and `details.status === "ok"` means the work completed successfully. The provider leaves streaming results and unrecognized or non-clean reports to the shell's generic compact fallback. Register the wrapped tool after loading settings, as in the README.

```ts
pi.registerTool(
  withCodePreviewShell(reportTool, {
    compactSummary: ({ phase, args, result, context }) => {
      if (context.isError || (phase !== "settled" && result)) return undefined;
      const subject = typeof args.path === "string" ? args.path : "";
      if (phase !== "settled") return { subject };

      const details = result?.details;
      if (
        !details ||
        typeof details !== "object" ||
        !("status" in details) ||
        details.status !== "ok" ||
        !("warnings" in details) ||
        !Array.isArray(details.warnings) ||
        details.warnings.length !== 0
      )
        return undefined;

      return { subject, outcome: "success" };
    },
  }),
);
```

Use your tool's authoritative domain result to distinguish success, warnings, cancellation, and uncertainty. Discover important warnings independently of preview-body rendering; do not flatten components, take their first line, or inspect ANSI colors to build summaries. The wrapper changes presentation only and preserves execution, tool schemas, prompt metadata, and result contents.

## Nested builtin summaries

`projectBuiltinCompactSummary(tool, input)` applies the same builtin semantic rules without a renderer context, I/O, or private write-registry lookup. Call it transiently before converting the native result:

```ts
const summary = projectBuiltinCompactSummary("write", {
  ...captureBuiltinCompactPolicy(),
  phase: "settled",
  args,
  result,
  cwd,
  isError,
  beforeWrite: { kind: "unknown" },
});
```

Import both helpers from `pi-code-previews/builtin-projection`; the root entry omits the builtin rules so extensions that don't project builtin results don't load them. The policy snapshot contains `secretWarnings`, `bashWarnings`, `secretScanChars`, `maxWriteDiffBytes`, and `maxWriteDiffChangedLineCells`. Before-write evidence is explicitly `unknown`, `new`, or `{ kind: "snapshot", value }`. Only an observed absent file warrants `new`. Nested execution must not wrap writes or read files merely to obtain preview evidence. Unknown or unsafe projections return `undefined` and require a conservative fallback.

The projector never returns raw output. Redact sensitive text and bound all retained subjects, counters, metadata, and issues before storing them.

A summary's `children` contains `{ entries, total }`. Each entry keeps `label`, `subject`, `status`, and measured `durationMs`, with optional `action`, `counters`, `metadata`, and its own `issues`. Standalone and child headings share rendering rules, apart from branch indentation. `status` controls the displayed classification.

The collapsed child selection and row rules are in the [standard](../../../docs/architecture/tool-presentation.md#registration-and-policy). `selectCompactChildren(children)` exposes that selection. `renderCompactRow`, `renderCompactIssues`, and `renderCompactChildren(children, theme, width, { animationFrame?, timingEnabled?, layout?, all? })` share the shell's policy with nested and custom views. The flat layout lists every caller-bounded retained entry with all of its issues beneath it; `all` shows every retained entry in tree layout too. `captureCodePreviewPresentationPolicy()` returns a detached `{ toolCallTiming, toolCallCollapsedStyle }` snapshot without I/O. Capture collapsed style at registration to match the shell, and read timing again when rendering.

## Custom messages

Wrap a custom-message presenter with `withCodePreviewMessageShell(present)` and register the result with `pi.registerMessageRenderer` at factory time. The presenter receives the message, Pi's `{ expanded, outputPad }` plus the owner's `collapsedStyle`, and the theme, and returns a `CodePreviewMessage`:

- `name` labels the compact row, as a tool name does; `label` titles the preview heading and defaults to `name`.
- `summary` is a settled `CompactSummary`: action, subject, counters, metadata, outcome, and issues. Classify the outcome as a tool would: `returned` for ordinary delivery, `attention` for a question, and success, warning, error, or cancelled by what happened. Issues render through `renderCompactIssues`. Set `messageIcon: "received"` on a message someone wrote; tools that deliver one set `"sent"`. A successful or neutral heading then shows `←` or `→` instead of its check or dot.
- `collapsed` and `expanded` return the body components. Bound the collapsed words yourself, about ten wrapped lines with an expansion affordance; `expanded` defaults to `collapsed`. Collapsed in compact style, a message is a bare compact row like a collapsed compact tool row, with the collapsed body beneath it indented as issues are; write that body without its own leading indent (`options.collapsedStyle` tells you which view you are drawing).
- `expandLabel` names what expansion reveals. A collapsed preview frame then shows the configured expand hint, in the bottom border in border mode; collapsed compact rows show none, as compact tool rows don't.
- `attachments` holds native components such as `Image`, drawn unchanged below the frame as Pi draws a tool result's images.

The shell draws the frame a settled tool row has under the owner's loaded `toolCallBackground` and `toolCallCollapsedStyle`: Code Previews' outcome-coloured border, Pi's tool-row backgrounds, or none; collapsed compact rows are unframed in every mode. Messages have no duration, so no timing appears. Pi rebuilds message components whenever it redraws them, so a message adopts the settings its owner loads at session start, as that owner's tool registration captures them. Pi's own spacer separates messages exactly as it separates tool rows; the shell adds no blank rows. A presenter, body, or drawing failure falls back to the message's plain text. The wrapper is presentation only: it never executes anything, changes message content, or acquires resources.

`galleryMessageFrames` draws a message in each background mode, and `galleryTranscriptFrames` draws tool rows and messages through Pi's own transcript components so they can be reviewed side by side.

## Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Add it as a runtime dependency (`"pi-code-previews": "workspace:*"` inside the cosmic-pi workspace; it isn't published to npm). Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode and collapsed style, so load settings before wrapping and re-register tools on /reload. Do not wrap tools owned by other extensions. Run checks.
```
