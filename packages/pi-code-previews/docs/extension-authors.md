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

Cooperative animation also requires `scheduleAnimation` from the registering extension's session. Pi isolates extension module instances, so loading settings cannot activate another extension's scheduler. Compose `CodePreviewSchedulerService.layer` into the owner's runtime, pass its `schedule` callback through the shell options, and reject scheduling after that session is replaced. Runtime disposal cancels every remaining animation. Built-in previews use their own scheduler by default. Native `codemode` opts into the `animateProgress` content option described in the standard.

Pass `compactSummary` to `withCodePreviewShell` to provide semantic action, subject, counts, metadata, outcome, and issues. The callback receives `{ phase, args, result, context }`. Outcome rules and the generic fallback are in [registration and policy](../../../docs/architecture/tool-presentation.md#registration-and-policy).

Report problems as `issues: CompactIssue[]`, following [Issues](../../../docs/architecture/tool-presentation.md#issues). `mergeCompactIssues` and `compactIssueSeverity` help combine and classify issue lists. Supply `expandedContent: { renderCall, renderResult }` for compact expansion, following [expanded composition](../../../docs/architecture/tool-presentation.md#expanded-composition).

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

Both helpers are public exports. The policy snapshot contains `secretWarnings`, `bashWarnings`, `secretScanChars`, `maxWriteDiffBytes`, and `maxWriteDiffChangedLineCells`. Before-write evidence is explicitly `unknown`, `new`, or `{ kind: "snapshot", value }`. Only an observed absent file warrants `new`. Nested execution must not wrap writes or read files merely to obtain preview evidence. Unknown or unsafe projections return `undefined` and require a conservative fallback.

The projector never returns raw output. Redact sensitive text and bound all retained subjects, counters, metadata, and issues before storing them.

A summary's `children` contains `{ entries, total }`. Each entry keeps `label`, `subject`, `status`, and measured `durationMs`, with optional `action`, `counters`, `metadata`, and its own `issues`. Standalone and child headings share rendering rules, apart from branch indentation. `status` controls the displayed classification.

The collapsed child selection and row rules are in the [standard](../../../docs/architecture/tool-presentation.md#registration-and-policy). `selectCompactChildren(children)` exposes that selection. `renderCompactRow`, `renderCompactIssues`, and `renderCompactChildren(children, theme, width, { animationFrame?, timingEnabled?, layout?, all? })` share the shell's policy with nested and custom views. The flat layout lists every caller-bounded retained entry with all of its issues beneath it; `all` shows every retained entry in tree layout too. `captureCodePreviewPresentationPolicy()` returns a detached `{ toolCallTiming, toolCallCollapsedStyle }` snapshot without I/O. Capture collapsed style at registration to match the shell, and read timing again when rendering.

## Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Install it as a runtime dependency with the package manager this project uses, e.g. `npm install pi-code-previews`. Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode and collapsed style, so load settings before wrapping and re-register tools on /reload. Do not wrap tools owned by other extensions. Run checks.
```
