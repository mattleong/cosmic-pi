# pi-code-previews

Syntax-highlighted builtin previews, native codemode/MCP presentation, and a reusable tool shell.

The package publishes TypeScript source and runs directly through Pi's Jiti loader; it has no generated distribution or build prerequisite.

`pi-code-previews` makes `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` output easier to scan in the pi TUI without changing what the tools do. If another extension already owns one of those tools, `pi-code-previews` skips that preview instead of conflicting with it. One stable public `pi.registerToolRenderer` resolver adds presentation without replacing execution definitions or changing tool selection/exposure. Write alone keeps an execution hook for before-write snapshots. Native `codemode` and standalone MCP previews are included; Pi independently owns their execution and the `/mcp` manager.

## Features

- Distinct emoji labels and syntax-highlighted previews for commands, files, diffs, and search results.
- Clearer `edit` and `write` diffs, including pending edit previews.
- Readable `grep` results grouped by file.
- Compact `find` and `ls` path lists with optional icons.
- Native `codemode` program previews and neutral nested-call rows, while retaining Pi’s native execution.
- Standalone native MCP tool/resource previews, including progress, recovery, and native images.
- Optional visual warnings for risky-looking shell commands and secret-looking output.
- Opt-in one-row collapsed tool calls, including pending and running calls.
- Tool call duration timing inline in compact summaries, or in result footers and border frames.
- Configurable themes, line counts, icons, and highlighting behavior.

## Install

Requires **Pi 1.0.1 or later** (`registerToolRenderer`); tested with **Pi 1.0.2**.

Install from npm:

```bash
pi install npm:pi-code-previews
```

The source is maintained in the [cosmic-pi monorepo](https://github.com/mattleong/cosmic-pi/tree/main/packages/pi-code-previews).

Previously installed standalone `pi-mcp-previews` must be removed manually from every scope: run `pi remove npm:pi-mcp-previews` (add `-l` for project-local installs), or use `pi remove` with the exact local source shown by `pi list`. Remove any explicit old extension paths, then reload. No user configuration or credentials are changed automatically. See the [migration guide](../../docs/migrations/native-mcp-codemode.md).

## Usage

Once installed, previews are enhanced automatically for:

- `bash`
- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- Native `codemode`, when its builtin source is eligible (including later MCP activation)
- Native `mcp__*` calls and `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`

Everything lives under one command, `/code-previews`; type it and a space to autocomplete its subcommands. Open settings inside pi with:

```text
/code-previews settings
```

`/code-previews settings help` lists every setting, `/code-previews settings status` shows the values in effect, and `/code-previews settings <id> <value>` changes one. Check status with:

```text
/code-previews health
```

The health panel shows configured tools, available renderer presentation, write registration errors, unavailable tools, disabled previews, foreign-owner conflicts, and native MCP renderer availability. Individual builtin/codemode preview toggles are available in the Preview tools submenu and take effect after `/reload`; they never activate or hide executable tools. Standalone MCP and supported third-party presentation are independent of that list.

The resolver is registered once during factory loading, not once per session. Replay rows created before startup preserve downstream content, then adopt their originating session's trusted settings when ready. Appearance is captured for that owner; retirement cancels its animations without borrowing replacement settings or schedulers. Public metadata is rechecked when choosing renderers. Only write registers an execution definition: its real before-write hook preserves activation and tracks attempted/successful registration separately so a refresh failure after mutation can retry. Discovery failures stop startup; a write registration error is bounded and does not disable other presentation.

### Supported third-party extensions

Code Previews includes a siloed, renderer-only `pi-web-access` adapter for `web_enable`,
`web_search`, `source_check`, `fetch_content`, and `get_search_content`. It follows the selected
preview/compact style and background without changing execution, activation, permissions, or
model-facing results. Expansion preserves the extension's own content and adds complete arguments
and raw output/recovery, including text its own expanded renderer may clip. Pi still draws images.

Admission requires public metadata for the exact `npm:pi-web-access` package (version/tag selectors
included), its package root, and a known `dist/index.js` or `index.ts` entry. Local/git installs,
renamed tools, missing/duplicate ownership, and other packages retain their original rendering.
Unknown or malformed results use conservative generic presentation, never inferred success.
No `pi-web-access` dependency or configuration change is required.

All external support lives under `src/third-party/`, with one static registry entry per adapter.
See [third-party adapters](docs/third-party-renderers.md) for the compatibility and add/remove
contract; builtin/native admission remains separate.

## Native codemode

Code Previews chooses native `codemode` renderers only when public source metadata identifies `builtin:codemode`. It does not require activation at startup: later MCP activation gets presentation without `/reload`. Missing, excluded, inactive, and foreign tools are never introduced or enabled for styling.

Pi's builtin definition remains unchanged. Code Previews neither calls nor intercepts `createCodemodeExtension`, replaces the engine, or registers a codemode execution definition. Pi retains parameter schemas, grammar, prompt metadata, live `codemode.mode`/`inlineBudget`, model access, nested permission hooks, cancellation, and branch-scoped `store()`/`load()` behavior.

`codemode` is included in the default preview-tools selection. Existing explicit `tools` lists must add `codemode` to opt in; removing it disables styling, not native execution. Unknown or foreign source metadata falls through to downstream renderers. Resolver precedence follows Pi's extension load order, without execution registration conflicts or forced takeover.

Native child `ok` uses a muted completion checkmark, without a redundant status label or a confirmed operation outcome. A completed script with handled child errors shows a warning; cancelled/unsettled children leave the overall outcome unconfirmed. A native failure header remains a failure: guest-controlled error names and stacks cannot prove cancellation, so abort diagnostics are retained without asserting a typed stop reason. Malformed historical details fall back conservatively. Expanded views retain the complete original program, native output, errors, recovery paths, and image evidence; call arguments are sanitized, abbreviated native previews, never fabricated nested results. Complete leading paths and targets survive later JSON truncation; cut string values carry an ellipsis. MCP and background-task rows show observed actions and targets, never inferred fields beyond the preview. Recoverable output clipping stays quiet while collapsed, with the saved-output path on expansion; missing recovery or save failures remain warnings. Rendering reads no saved-output files.

Direct unshadowed `searchTools`, `describeTool`, and `describeNamespace` calls add a **tool discovery** hint. An explicit static MCP tool target or `namespace: "mcp__…"` adds **MCP discovery** instead. This is source-derived intent, not proof a helper or branch executed; expansion explains it. Comments, strings, unused function bodies, aliases, dynamic callees, invalid or overly complex source stay unclassified. Dynamic lookup targets never gain guessed MCP specificity. Discovery helpers do not inflate native dispatch counts: discovery-only source with a confirmed empty ledger omits `0 calls`, while mixed scripts retain their actual tool-call count and timing. Incomplete/unavailable ledgers keep their warnings and uncertainty, and model dispatches retain the generic call counter. Full Program, Calls, Output, recovery and images remain available.

Native MCP calls inside Code Mode show readable `mcp call server / tool` rows from unambiguous registered `mcp__*` aliases, including short collision-hash suffixes. Ambiguous or potentially truncated names remain unchanged rather than guessing the remote identity. Resource read/list/template rows show only observed, sanitized argument targets; cut targets carry an ellipsis. Expansion retains the registered name, abbreviated argument evidence, errors and recovery text alongside the complete program and script output. This uses the existing `codemode` preview toggle and does not change MCP execution, authentication, connections, exposure, or tool activation. Standalone calls use Code Previews' included MCP renderers; Pi alone manages MCP.

Native presentation keeps five calls collapsed. Preview style shows at most eight wrapped program rows and advertises hidden output or errors. Expansion retains **Program → Calls → Output**, omitting an empty Output section while streaming. Parent and child measured timing includes subsecond calls (for example, `379ms`) and obeys `toolCallTiming`. The parent shows its observed elapsed duration; each child shows its own native measurement, never a sum of concurrent calls. Pending/replayed parents without a measured start and children without valid durations remain untimed; live native content animates in both styles and expansion states even with timing disabled.

Call evidence inspects only the latest 256 `details.calls` slots. Invalid records do not erase valid neighbors; omitted or rejected records leave completed outcomes unconfirmed and use **N calls listed**, not an inferred dispatch total. Expanded Calls explains the retained coverage even when the outer header is unknown, and saved-output paths validate independently. These are native metadata records, not richer domain receipts or the persisted `nestedCalls` unavailable to renderers. No older problem records are searched outside the bounded window.

### Standalone native MCP

Standalone native MCP previews are included and share Code Previews' appearance settings and session-owned scheduler. Registered definitions need exact `builtin:mcp` source metadata. Historical calls whose server has not connected can use conservative presentation only when the independent unique builtin `/mcp` manager is proven; unknown names retain their registered alias rather than guessing an identity.

Arguments, progress, output, resource results, clipping/recovery evidence, errors, and native images remain available through expansion. Returned transport is neutral, not proof of domain success. Recognized saved-output envelopes stay quiet while collapsed; missing recovery and unrelated warnings remain visible. Rendering never reads spill files. Code Previews neither composes nor intercepts `createMcpExtension`, registers `/mcp` or MCP execution definitions, nor changes authentication, connections, server configuration, activation, exposure, or permission gates.

There is no MCP startup toggle in Code Previews. Previously persisted `nativeMcpPreviews` fields are inert unknown data, preserved by ordinary saves.

## Benchmarks

From a source checkout, diff/edit rendering benchmarks are available for local performance checks:

```bash
pnpm bench:recommended
```

Individual suites cover diff wrapping, edit renderer previews, write/edit diff generation, and word-emphasis/pathological changed-line pairing.

See [docs/word-emphasis.md](docs/word-emphasis.md) for word-emphasis accuracy notes, confidence scoring, telemetry, and golden-corpus workflow.

Use `pnpm word:accuracy` for the labeled span/pair accuracy report and
`pnpm bench:word-pathology` for the corresponding performance guardrails.

## Configuration

Settings are stored globally in Pi's agent config directory:

```text
$PI_CODING_AGENT_DIR/code-previews.json
```

When `PI_CODING_AGENT_DIR` is not set, this defaults to:

```text
~/.pi/agent/code-previews.json
```

Settings apply in this order, from lowest to highest priority:

1. Built-in defaults.
2. The nested `codePreview` object in `$PI_CODING_AGENT_DIR/settings.json`.
3. The nested `codePreview` object in the trusted project's `.pi/settings.json`.
4. Flat overrides in `$PI_CODING_AGENT_DIR/code-previews.json`.

Untrusted project settings are ignored. Invalid fields retain the preceding value without discarding valid siblings. The settings panel saves only edited overrides through the existing settings store; it does not copy a project's other defaults into global settings. A choice in the panel applies globally: the panel removes an override only when every project would then inherit the chosen value. **Restore defaults** removes the panel's overrides, so values from `settings.json` and the built-in defaults apply again. A settings file that can't be read, or that has invalid fields, is reported when a session starts and in `/code-previews health`.

### Compact collapsed calls

Set this in `code-previews.json`, or under `codePreview` in a trusted project's `.pi/settings.json`:

```json
{
  "toolCallCollapsedStyle": "compact"
}
```

You can also choose **Collapsed tool calls** under **Appearance** in `/code-previews settings`. The default is `preview`, which keeps the existing presentation. The shell captures this setting at wrapping or presentation-owner readiness; changes require `/reload`.

In compact mode, ordinary collapsed calls use one extension-rendered text row while arguments arrive, during execution, and after settlement. The row prioritizes the status glyph, tool name and optional action, then the target subject and whole counter tokens. Counters are alternatives in priority order: the first that fits is selected, so a provider can offer a shorter fallback such as `3 failed` for narrow rows; without counters, the first nonempty metadata item is selected. Counters can use the remaining terminal cells while preserving up to 12 subject cells. Long subjects yield space to whole progress counters before those counters are dropped. Long subjects use grapheme-safe middle elision to retain both ends. There is at most one routine detail. When no counter or metadata is present, enabled timing appears for bash or calls lasting at least ten seconds. A cooperative provider can set `showTiming: true` to show measured timing beside its routine detail; the default one-second eligibility threshold still applies. Native Code Mode separately opts into `showShortTiming` for its parent shell and child summaries. Counts take priority when both cannot fit. Compact rows omit the expand hint. Optional fields disappear before the identity is clipped at very narrow widths. Counters are never partially displayed. Status uses shared icons instead of words. The running icon animates even when `toolCallTiming` is off; it stops after settlement or session shutdown. With timing off, expansion pauses the hidden icon's animation and collapsing resumes it. Pending calls have no execution duration, and restored calls do not gain a fabricated duration.

Ordinary live output and pending write/edit previews stay hidden until expanded. Each warning or error is one line under the heading, with its own icon and colour: known filesystem and command-status errors get short messages ("File not found", "Exited with code 1"), and unrecognized errors show their first line. The same words appear when expanded, followed by any technical detail or agent-facing recovery. Cancellation uses neutral styling and unconfirmed outcomes use `?`. Routine read-range and known complete-line pagination hints, including read byte caps, appear only when expanded. Byte-cap hints require a recognized numeric size-limit footer and explicit evidence that the final returned line is complete. Routine grep/find/ls result caps use a quiet `limit reached: N` counter, prioritized over optional metadata and timing. A reached cap does not establish a total, additional results, or how many survived output truncation. Successful writes use `diff skipped: size` or `diff skipped: complexity` metadata only for structured size evidence or computed guards with known previous contents. Missing history, non-regular previous paths, unclassified skip reasons, and missing edit diffs are informational, since they concern the preview rather than the change; possible secrets are warnings. Other byte caps, partial lines, oversized-line recovery, and unknown truncation are warnings too. Original tool results are unchanged. Expansion shows the heading, the issues with their details, then unique content, or falls back to the original renderers, within the configured `toolCallBackground`. Compact mode takes precedence over per-tool collapsed-preview toggles and line limits; those retain their existing meaning in `preview` mode. `toolCallTiming` remains independent.

Compact rendering covers eligible builtin `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`, plus native `codemode` and standalone MCP renderer presentation. It does not activate disabled tools or replace tools owned by another extension. All tools wrapped with `withCodePreviewShell` use compact rows, including tools without a summary provider. Missing, malformed, or incomplete summaries get a generic row (the error's first line, or a details-on-expand hint), never an automatic full card. In `preview` style, builtin tools show the same issue lines under their heading, including risky-command and secret warnings before the call runs. Pi's host-owned blank separator remains, and Pi still renders native images outside the extension's text-row budget.

### Project settings

You can set defaults in `.pi/settings.json`:

```json
{
  "codePreview": {
    "shikiTheme": "dark-plus",
    "wordEmphasis": "all",
    "toolCallBackground": "border",
    "toolCallCollapsedStyle": "preview",
    "toolCallTiming": true,
    "readContentPreview": false,
    "writeContentPreview": false,
    "editDiffPreview": false,
    "grepResultPreview": false,
    "findResultPreview": false,
    "lsResultPreview": false,
    "bashResultPreview": false,
    "grepCollapsedLines": 40,
    "pathListCollapsedLines": 40,
    "pathIcons": "unicode",
    "tools": ["bash", "write", "edit", "find", "ls"]
  }
}
```

The extension owns one scoped Effect runtime per Pi session. Repeated starts replace and dispose the previous runtime; syntax initialization, timing fibers, settings I/O, and preview writes are interrupted or finalized on session shutdown. One process-local coordinator serializes settings work across live and one-shot runtimes. Monotonic admissions prevent an older result from replacing a newer successful publication, while failed or cancelled work advances no publication currency. Settings use same-directory atomic replacement and global flush waits for work from every runtime. Preview writes retain Pi's direct-write semantics so symlinks, hard links, open descriptors, file modes, and inode identity behave like the built-in write tool.

In `preview` style, when content/result/diff previews are disabled, collapsed successful output or code previews are hidden while the tool call stays visible; use pi's expand shortcut to view them on demand. `writeContentPreview: false` hides collapsed write content and write diffs, and `editDiffPreview: false` hides collapsed proposed/applied edit diffs. `bashResultPreview: false` applies to all successful `bash` output, while grep/find/ls result toggles also hide matching `bash` commands that start with `grep`, `find`, or `ls`.

For expanded calls and noncompact fallbacks, `toolCallBackground: "off"` removes the colored background from Code Previews presentations. `toolCallBackground: "border"` replaces the background with a border-only frame. This setting changes the tool render shell, so it takes effect after `/reload`.

`toolCallTiming: false` hides tool durations, including measured durations in nested compact call trees. When enabled, most tools show durations only after one second. Native Code Mode also displays measured subsecond program and child durations. Measured durations appear inline in compact summaries. Detailed rendering uses the result footer unless `toolCallBackground` is `border`; in border mode durations appear in the top-right border corner.

## Extension author integration

Other pi extensions can opt their own tools into the code-preview shell by importing `withCodePreviewShell`. The wrapper captures shell mode and collapsed style when it is called, so project-aware consumers must load trusted project settings before wrapping and registering the tool inside `session_start`:

```ts
import { withCodePreviewShell, loadCodePreviewSettings } from "pi-code-previews";

export default function myExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted());
    pi.registerTool(withCodePreviewShell(myToolDefinition));
  });
}
```

This preserves the original tool definition and only decorates rendering. With no arguments,
`loadCodePreviewSettings()` reads global settings only. If a consumer only needs global settings,
it may load them before initial tool registration. Reloading settings after a tool has been wrapped
does not change that tool's `renderShell` or collapsed style; wrap/register it only after the desired settings load.

If an extension imports `pi-code-previews`, it should list it in `dependencies` so users do not
need to install it separately.

Compound renderers can call `getCodePreviewToolIcon(toolName)` to reuse the same emoji as the
standalone `bash`, `read`, `write`, `edit`, `grep`, `find`, or `ls` call. Unsupported names return
`undefined`, allowing the caller to keep a neutral fallback. `getTextContent(content)` joins a
tool result's text parts with newlines, the same projection the builtin renderers use.

### Renderer-only integration

`withCodePreviewRenderers({ name, label? }, renderers, options)` shares the shell policy without requiring `execute`, a parameter schema, or a full tool definition. It returns only public `renderShell`, `renderCall`, and `renderResult` callbacks. Set `selfShell: true` when a retained resolver facade must keep Pi's fixed self shell across all appearance modes; preview/on then supplies a native-like combined background.

Register a resolver with `pi.registerToolRenderer` once during extension factory loading, not on every session start. Load trusted settings before creating the session's renderers; retain that owner's appearance and revoke its scheduler on replacement/shutdown. Treat `next()` only as public renderer callbacks. Do not use presentation to take over foreign execution definitions, compose native managers, or change selection/exposure. Extension-owned questionnaire/task/subagent/image tools keep `withCodePreviewShell` and their normal executable registrations.

### Compact summaries

Workspace integrations include native MCP presentation, subagents, background tasks, questionnaires, and image generation. Each supplies its own semantic summary; `loadCodePreviewSettings` alone does not change rendering. Successes, failures, cancellations, and incomplete results all stay compact while collapsed. Unknown outcomes are not labelled successful. Expansion retains the existing details, including subagent recovery/report cards and MCP uncertainty. Child-only acknowledgements and parent-message tools use the same shell.

Cooperative animation also requires `scheduleAnimation` from the registering extension's session. Pi isolates extension module instances, so loading settings cannot activate another extension's scheduler. Compose `CodePreviewSchedulerService.layer` into the owner's runtime, pass its `schedule` callback through the shell options, and reject scheduling after that session is replaced. Runtime disposal cancels every remaining animation. Built-in previews use their own scheduler by default. A content renderer may opt into `animateProgress: true` to keep visible progress animated when timing is disabled or content is expanded; it defaults to false and reuses the same owner-scoped scheduler. Native `codemode` opts in. Declined scheduler admission never borrows a replacement session's scheduler.

Pass `compactSummary` to `withCodePreviewShell` to provide semantic action, subject, counts, metadata, outcome, and issues. The callback receives `{ phase, args, result, context }`. Settled summaries require an explicit outcome; a false host error flag does not prove success. When Pi reports an error the summary did not classify, the shell adds one error issue from the first line of the error text. Missing or malformed summaries remain compact when collapsed and use original details on expansion.

Report problems as `issues: CompactIssue[]`. Each issue is `{ severity: "error" | "warning" | "info", code, message, detail? }`. Write `message` as one short human sentence; it appears unchanged collapsed and expanded. Put agent-facing recovery, commands, IDs, and diagnostics in `detail`, which appears dimmed beneath the message only when expanded. Use `info` for routine notes such as pagination or saved-output locations; they appear only when expanded. `firstLineMessage(text, fallback)` gives unclassified errors a one-line message. `mergeCompactIssues` and `compactIssueSeverity` help combine and classify issue lists.

Supply `expandedContent: { renderCall, renderResult }` for compact expansion. Each callback has its original signature and returns unique content without another heading or issue list. Return an empty `Container` for an intentionally empty slot; omitted hooks keep the original slot. The shell composes the heading, the issues, then unique call and result content. Label raw output (for example with `expandedSection(theme, "Error", …)`) rather than trying to avoid repeating facts an issue states. Preview style keeps original callbacks. Original and content-only slots keep independent caches.

Use `createBoundedCompactIssuesSchema({ maxTextLength, maxEntries })` for issues that cross package or persistence boundaries. `pi-code-previews/testing` exports a source-only, test-runner-independent `createToolPresentationHarness(toolOrRenderers, { theme?, width?, state?, cwd? })` with call/result updates, rendering, invalidation, and `cycle()` over expansion states. It never invokes execution. The same subpath provides `renderContextFixture`, `applyPresentationSettings`/`withPresentationSettings`, `captureRegistrations` (including `toolRenderers` and `resolveToolRenderers(name, base?)`), and `animationSchedulerProbe`/`probeAnimationOwnership`. See the [normative standard](../../docs/architecture/tool-presentation.md) for the full contract and inventory.

This example assumes `reportTool` takes a `path` argument. Its domain contract puts every warning in `details.warnings`, and `details.status === "ok"` means the work completed successfully. The provider leaves streaming results and unrecognized or non-clean reports to the shell's generic compact fallback. Register the wrapped tool after loading settings, as above.

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

Use your tool's authoritative domain result to distinguish success, warnings, cancellation, and uncertainty. `context.isError === false` alone does not prove success. Discover important warnings independently of preview-body rendering; do not flatten components, take their first line, or inspect ANSI colors to build summaries. The wrapper changes presentation only and preserves execution, tool schemas, prompt metadata, and result contents.

### Nested builtin summaries

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

A summary's `children` contains `{ entries, total }`. Each entry keeps `label`, `subject`, `status`, and measured `durationMs`, with optional `action`, `counters`, `metadata`, and its own `issues`. Standalone and child headings share rendering rules, apart from branch indentation. `status` controls the displayed classification; a child never changes its parent's outcome. Never let operation success hide a delivery failure.

The collapsed shell selects five children, preferring active and problem calls. Each child row shows its primary issue in place of its counter; when the row is too narrow, the issue moves to an indented line beneath it rather than disappearing. The omission row counts hidden failures; overflowing counts wrap rather than disappearing or losing digits on narrow terminals. `selectCompactChildren(children)` exposes that selection. `renderCompactRow`, `renderCompactIssues`, and `renderCompactChildren(children, theme, width, { animationFrame?, timingEnabled?, layout?, all? })` share the shell's policy with nested and custom views. The flat layout lists every caller-bounded retained entry with all of its issues beneath it; `all` shows every retained entry in tree layout too. `captureCodePreviewPresentationPolicy()` returns a detached `{ toolCallTiming, toolCallCollapsedStyle }` snapshot without I/O. Capture collapsed style at registration to match the shell, and read timing again when rendering.

### Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Install it as a runtime dependency with the package manager this project uses, e.g. `npm install pi-code-previews`. Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode and collapsed style, so load settings before wrapping and re-register tools on /reload. Do not wrap tools owned by other extensions. Run checks.
```

## Screenshots

<img width="1053" height="368" alt="Screenshot 2026-05-10 at 12 01 39 PM" src="https://github.com/user-attachments/assets/58435989-ec3d-4d08-a956-7422126e6e8b" />
