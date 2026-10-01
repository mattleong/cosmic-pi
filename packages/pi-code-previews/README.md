# pi-code-previews

Syntax-highlighted previews for pi's built-in tool calls.

The package publishes TypeScript source and runs directly through Pi's Jiti loader; it has no generated distribution or build prerequisite.

`pi-code-previews` makes `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` output easier to scan in the pi TUI without changing what the tools do. If another extension already owns one of those tools, `pi-code-previews` skips that preview instead of conflicting with it. Core renderer replacements never enable, disable, or reorder Pi's active tool names. Standalone native MCP presentation belongs to the separate [pi-mcp-previews](../pi-mcp-previews/) package.

## Features

- Distinct emoji labels and syntax-highlighted previews for commands, files, diffs, and search results.
- Clearer `edit` and `write` diffs, including pending edit previews.
- Readable `grep` results grouped by file.
- Compact `find` and `ls` path lists with optional icons.
- Native `codemode` program previews and neutral nested-call rows, while retaining Pi’s native execution.
- Optional visual warnings for risky-looking shell commands and secret-looking output.
- Opt-in one-row collapsed tool calls, including pending and running calls.
- Tool call duration timing inline in compact summaries, or in result footers and border frames.
- Configurable themes, line counts, icons, and highlighting behavior.

## Install

Install from npm:

```bash
pi install npm:pi-code-previews
```

The source is maintained in the [cosmic-pi monorepo](https://github.com/mattleong/cosmic-pi/tree/main/packages/pi-code-previews).

## Usage

Once installed, previews are enhanced automatically for:

- `bash`
- `read`
- `write`
- `edit`
- `grep`
- `find`
- `ls`
- Native `codemode`, when active at startup and eligible (see below)

Everything lives under one command, `/code-previews`; type it and a space to autocomplete its subcommands. Open settings inside pi with:

```text
/code-previews settings
```

`/code-previews settings help` lists every setting, `/code-previews settings status` shows the values in effect, and `/code-previews settings <id> <value>` changes one. Check status with:

```text
/code-previews health
```

The health panel shows configured tools, installed replacements, registration errors, inactive/unavailable native tools, disabled tools, and replacements skipped because another extension owns that tool. Individual tool toggles are available in the Preview tools submenu in `/code-previews settings` and take effect after `/reload`.

Renderer installation is best effort after planning completes. A discovery or definition-construction failure stops startup before registration begins. If one `registerTool` call fails, later replacements are still attempted and successful replacements keep a live session runtime. Attempted names and successful installs are tracked separately, so a Pi 0.84 refresh failure after registry mutation remains retryable on the next session start. There is no rollback of successful installs.

### Native codemode

On Pi versions exposing `createCodemodeExtension`, Code Previews styles native `codemode` only when it is active at `session_start` and public source metadata identifies `builtin:codemode`. Eligibility is captured before settings I/O. Missing, excluded, inactive, or foreign tools are never introduced or enabled. MCP activation after startup gets styling on the next `/reload`.

Code Previews creates its **own fresh native definition** through the public factory and a local API adapter, then decorates only its render callbacks. The loaded builtin is not mutated or wrapped. Pi retains execution, parameter-schema identity, grammar, prompt metadata, live `codemode.mode`/`inlineBudget`, default model access, nested hooks, and branch-scoped `store()`/`load()` behavior. No custom engine is involved.

`codemode` is included in the default preview-tools selection. Existing explicit `tools` lists must add `codemode` to opt in; removing it disables styling, not native execution. If a previously styled definition is genuinely owned by this loaded lifecycle, a repeated start restores a fresh unstyled native definition when styling is disabled or the tool is inactive. Retired renderer callbacks cannot animate through the replacement session.

Pi’s first extension registration wins. Ordinary CLI discovery places Code Previews before the default builtin; an explicit earlier `-e builtin:codemode` can instead keep the native renderer. Health reports that visible-owner conflict rather than claiming installation or forcing a takeover. Ownership must match the unique public `/code-previews` command source; unavailable or ambiguous ownership evidence fails closed.

Native child `ok` uses a muted completion checkmark, without a redundant status label or a confirmed operation outcome. A completed script with handled child errors shows a warning; cancelled/unsettled children leave the overall outcome unconfirmed. A native failure header remains a failure: guest-controlled error names and stacks cannot prove cancellation, so abort diagnostics are retained without asserting a typed stop reason. Malformed historical details fall back conservatively. Expanded views retain the complete original program, native output, errors, recovery paths, and image evidence; call arguments are sanitized, abbreviated native previews, never fabricated nested results. Complete leading paths and targets survive later JSON truncation; cut string values carry an ellipsis. MCP and background-task rows show observed actions and targets, never inferred fields beyond the preview. Recoverable output clipping stays quiet while collapsed, with the saved-output path on expansion; missing recovery or save failures remain warnings. Rendering reads no saved-output files.

Native MCP calls inside Code Mode show readable `mcp call server / tool` rows from unambiguous registered `mcp__*` aliases, including short collision-hash suffixes. Ambiguous or potentially truncated names remain unchanged rather than guessing the remote identity. Resource read/list/template rows show only observed, sanitized argument targets; cut targets carry an ellipsis. Expansion retains the registered name, abbreviated argument evidence, errors and recovery text alongside the complete program and script output. This uses the existing `codemode` preview toggle and does not change MCP execution, authentication, connections, exposure, or tool activation. Standalone calls use the separate `pi-mcp-previews` package; Code Previews does not manage MCP.

Native presentation keeps five calls collapsed. Preview style shows at most eight wrapped program rows and advertises hidden output or errors. Expansion retains **Program → Calls → Output**, omitting an empty Output section while streaming. Parent and child measured timing includes subsecond calls (for example, `379ms`) and obeys `toolCallTiming`. The parent shows its observed elapsed duration; each child shows its own native measurement, never a sum of concurrent calls. Pending/replayed parents without a measured start and children without valid durations remain untimed; live native content animates in both styles and expansion states even with timing disabled.

Call evidence inspects only the latest 256 `details.calls` slots. Invalid records do not erase valid neighbors; omitted or rejected records leave completed outcomes unconfirmed and use **N calls listed**, not an inferred dispatch total. Expanded Calls explains the retained coverage even when the outer header is unknown, and saved-output paths validate independently. These are native metadata records, not richer domain receipts or the persisted `nestedCalls` unavailable to renderers. No older problem records are searched outside the bounded window.

### Standalone native MCP

Install [pi-mcp-previews](../pi-mcp-previews/) for always-on standalone native MCP tool/resource previews and Pi's native `/mcp` manager. It uses the public Code Previews shell and appearance settings, but owns its manager lifecycle and scheduling independently. Code Previews alone neither replaces nor manages MCP.

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

1. Built-in defaults, then `CODE_PREVIEW_*` environment defaults.
2. The nested `codePreview` object in `$PI_CODING_AGENT_DIR/settings.json`.
3. The nested `codePreview` object in the trusted project's `.pi/settings.json`.
4. Flat overrides in `$PI_CODING_AGENT_DIR/code-previews.json`.

Untrusted project settings are ignored. Invalid fields retain the preceding value without discarding valid siblings. The settings panel saves only edited overrides through the existing settings store; it does not copy a project's other defaults into global settings. `CODE_PREVIEW_TOOLS` is a separate process-level tool-selection override.

### Compact collapsed calls

Set this in `code-previews.json`, or under `codePreview` in a trusted project's `.pi/settings.json`:

```json
{
  "toolCallCollapsedStyle": "compact"
}
```

You can also choose **Collapsed tool calls** under **Appearance** in `/code-previews settings`, or start Pi with `CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE=compact`. The default is `preview`, which keeps the existing presentation. The wrapper captures this setting at tool registration; changes require `/reload`.

In compact mode, ordinary collapsed calls use one extension-rendered text row while arguments arrive, during execution, and after settlement. The row prioritizes the status glyph, tool name and optional action, then the target subject and whole counter tokens. Counters are alternatives in priority order: the first that fits is selected, so a provider can offer a shorter fallback such as `3 failed` for narrow rows; without counters, the first nonempty metadata item is selected. Counters can use the remaining terminal cells while preserving up to 12 subject cells. Long subjects yield space to whole progress counters before those counters are dropped. Long subjects use grapheme-safe middle elision to retain both ends. There is at most one routine detail. When no counter or metadata is present, enabled timing appears for bash or calls lasting at least ten seconds. A cooperative provider can set `showTiming: true` to show measured timing beside its routine detail; the default one-second eligibility threshold still applies. Native Code Mode separately opts into `showShortTiming` for its parent shell and child summaries. Counts take priority when both cannot fit. Compact rows omit the expand hint. Optional fields disappear before the identity is clipped at very narrow widths. Counters are never partially displayed. Status uses shared icons instead of words. The running icon animates even when `toolCallTiming` is off; it stops after settlement or session shutdown. With timing off, expansion pauses the hidden icon's animation and collapsing resumes it. Pending calls have no execution duration, and restored calls do not gain a fabricated duration.

Ordinary live output and pending write/edit previews stay hidden until expanded. Each warning or error is one line under the heading, with its own icon and colour: known filesystem and command-status errors get short messages ("File not found", "Exited with code 1"), and unrecognized errors show their first line. The same words appear when expanded, followed by any technical detail or agent-facing recovery. Cancellation uses neutral styling and unconfirmed outcomes use `?`. Routine read-range and known complete-line pagination hints, including read byte caps, appear only when expanded. Byte-cap hints require a recognized numeric size-limit footer and explicit evidence that the final returned line is complete. Routine grep/find/ls result caps use a quiet `limit reached: N` counter, prioritized over optional metadata and timing. A reached cap does not establish a total, additional results, or how many survived output truncation. Successful writes use `diff skipped: size` or `diff skipped: complexity` metadata only for structured size evidence or computed guards with known previous contents. Missing history, non-regular previous paths, unclassified skip reasons, missing edit diffs, and secrets are warnings. Other byte caps, partial lines, oversized-line recovery, and unknown truncation are warnings too. Original tool results are unchanged. Expansion shows the heading, the issues with their details, then unique content, or falls back to the original renderers, within the configured `toolCallBackground`. Compact mode takes precedence over per-tool collapsed-preview toggles and line limits; those retain their existing meaning in `preview` mode. `toolCallTiming` remains independent.

Compact rendering covers installed replacements for `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`, plus eligible fresh-native `codemode` composition. It does not activate disabled tools or replace tools owned by another extension. All tools wrapped with `withCodePreviewShell` use compact rows, including tools without a summary provider. Missing, malformed, or incomplete summaries get a generic row (the error's first line, or a details-on-expand hint), never an automatic full card. In `preview` style, builtin tools show the same issue lines under their heading, including risky-command and secret warnings before the call runs. Pi's host-owned blank separator remains, and Pi still renders native images outside the extension's text-row budget.

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

### Environment variables

Optional defaults can be set before pi starts:

```bash
CODE_PREVIEW_THEME=github-dark
CODE_PREVIEW_DIFF_INTENSITY=subtle # subtle, medium, or off
CODE_PREVIEW_READ_LINES=20
CODE_PREVIEW_READ_CONTENT=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_READ_LINE_NUMBERS=true # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_WRITE_CONTENT=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_WRITE_LINES=20
CODE_PREVIEW_EDIT_DIFF=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_EDIT_LINES=120 # or all
CODE_PREVIEW_WORD_EMPHASIS=all # all, smart, or off
CODE_PREVIEW_TOOL_CALL_BACKGROUND=border # on, off, border, true/false, yes/no, or 1/0
CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE=compact # preview or compact; default preview
CODE_PREVIEW_TOOL_CALL_TIMING=true # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_GREP_LINES=40
CODE_PREVIEW_GREP_RESULTS=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_FIND_RESULTS=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_LS_RESULTS=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_BASH_RESULTS=false # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_BASH_WARNINGS=true # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_PATH_LIST_LINES=40
CODE_PREVIEW_SYNTAX=true # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_SECRET_WARNINGS=true # true/false, on/off, yes/no, or 1/0
CODE_PREVIEW_PATH_ICONS=unicode # unicode, nerd, or off
CODE_PREVIEW_TOOLS=write,edit,grep # comma/space list, all, or none
```

`CODE_PREVIEW_TOOLS` overrides `codePreview.tools` for the current pi process.

The extension owns one scoped Effect runtime per Pi session. Repeated starts replace and dispose the previous runtime; syntax initialization, timing fibers, settings I/O, and preview writes are interrupted or finalized on session shutdown. One process-local coordinator serializes settings work across live and one-shot runtimes. Monotonic admissions prevent an older result from replacing a newer successful publication, while failed or cancelled work advances no publication currency. Settings use same-directory atomic replacement and global flush waits for work from every runtime. Preview writes retain Pi's direct-write semantics so symlinks, hard links, open descriptors, file modes, and inode identity behave like the built-in write tool.

In `preview` style, when content/result/diff previews are disabled, collapsed successful output or code previews are hidden while the tool call stays visible; use pi's expand shortcut to view them on demand. `CODE_PREVIEW_WRITE_CONTENT=false` hides collapsed write content and write diffs, and `CODE_PREVIEW_EDIT_DIFF=false` hides collapsed proposed/applied edit diffs. `CODE_PREVIEW_BASH_RESULTS=false` applies to all successful `bash` output, while grep/find/ls result toggles also hide matching `bash` commands that start with `grep`, `find`, or `ls`.

For expanded calls and noncompact fallbacks, `CODE_PREVIEW_TOOL_CALL_BACKGROUND=off` removes Pi's default colored tool box background for code-preview-owned tools. `CODE_PREVIEW_TOOL_CALL_BACKGROUND=border` replaces the background with a border-only frame. This setting changes the tool render shell, so it takes effect after `/reload`.

`CODE_PREVIEW_TOOL_CALL_TIMING=false` hides tool durations, including measured durations in nested compact call trees. When enabled, most tools show durations only after one second. Native Code Mode also displays measured subsecond program and child durations. Measured durations appear inline in compact summaries. Detailed rendering uses the result footer unless `toolCallBackground` is `border`; in border mode durations appear in the top-right border corner.

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

### Compact summaries

Workspace integrations include MCP Previews, subagents, background tasks, questionnaires, and image generation. Each supplies its own semantic summary; `loadCodePreviewSettings` alone does not change rendering. Successes, failures, cancellations, and incomplete results all stay compact while collapsed. Unknown outcomes are not labelled successful. Expansion retains the existing details, including subagent recovery/report cards and MCP uncertainty. Child-only acknowledgements and parent-message tools use the same shell.

Cooperative animation also requires `scheduleAnimation` from the registering extension's session. Pi isolates extension module instances, so loading settings cannot activate another extension's scheduler. Compose `CodePreviewSchedulerService.layer` into the owner's runtime, pass its `schedule` callback through the shell options, and reject scheduling after that session is replaced. Runtime disposal cancels every remaining animation. Built-in previews use their own scheduler by default. A content renderer may opt into `animateProgress: true` to keep visible progress animated when timing is disabled or content is expanded; it defaults to false and reuses the same owner-scoped scheduler. Native `codemode` opts in. Declined scheduler admission never borrows a replacement session's scheduler.

Pass `compactSummary` to `withCodePreviewShell` to provide semantic action, subject, counts, metadata, outcome, and issues. The callback receives `{ phase, args, result, context }`. Settled summaries require an explicit outcome; a false host error flag does not prove success. When Pi reports an error the summary did not classify, the shell adds one error issue from the first line of the error text. Missing or malformed summaries remain compact when collapsed and use original details on expansion.

Report problems as `issues: CompactIssue[]`. Each issue is `{ severity: "error" | "warning" | "info", code, message, detail? }`. Write `message` as one short human sentence; it appears unchanged collapsed and expanded. Put agent-facing recovery, commands, IDs, and diagnostics in `detail`, which appears dimmed beneath the message only when expanded. Use `info` for routine notes such as pagination or saved-output locations; they appear only when expanded. `firstLineMessage(text, fallback)` gives unclassified errors a one-line message. `mergeCompactIssues` and `compactIssueSeverity` help combine and classify issue lists.

Supply `expandedContent: { renderCall, renderResult }` for compact expansion. Each callback has its original signature and returns unique content without another heading or issue list. Return an empty `Container` for an intentionally empty slot; omitted hooks keep the original slot. The shell composes the heading, the issues, then unique call and result content. Label raw output (for example with `expandedSection(theme, "Error", …)`) rather than trying to avoid repeating facts an issue states. Preview style keeps original callbacks. Original and content-only slots keep independent caches.

Use `createBoundedCompactIssuesSchema({ maxTextLength, maxEntries })` for issues that cross package or persistence boundaries. `pi-code-previews/testing` exports a source-only, test-runner-independent `createToolPresentationHarness(tool, { theme?, width?, state?, cwd? })` with call/result updates, rendering, invalidation, and `cycle()` over expansion states. It never invokes execution. The same subpath provides `renderContextFixture`, `applyPresentationSettings`/`withPresentationSettings`, `captureRegistrations`, and `animationSchedulerProbe`/`probeAnimationOwnership`. See the [normative standard](../../docs/architecture/tool-presentation.md) for the full contract and inventory.

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

The collapsed shell selects five children, preferring active and problem calls. Each child row shows its primary issue in place of its counter; when the row is too narrow, the issue moves to an indented line beneath it rather than disappearing. The omission row counts hidden failures; overflowing counts wrap rather than disappearing or losing digits on narrow terminals. `selectCompactChildren(children)` exposes that selection. `renderCompactRow`, `renderCompactIssues`, `renderCompactToolCall`, and `renderCompactChildren(children, theme, width, { animationFrame?, timingEnabled?, layout?, all? })` share the shell's policy with nested and custom views. The flat layout lists every caller-bounded retained entry with all of its issues beneath it; `all` shows every retained entry in tree layout too. `captureCodePreviewPresentationPolicy()` returns a detached `{ toolCallTiming, toolCallCollapsedStyle }` snapshot without I/O. Capture collapsed style at registration to match the shell, and read timing again when rendering.

### Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Install it as a runtime dependency with the package manager this project uses, e.g. `npm install pi-code-previews`. Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode and collapsed style, so load settings before wrapping and re-register tools on /reload. Do not wrap tools owned by other extensions. Run checks.
```

## Screenshots

<img width="1053" height="368" alt="Screenshot 2026-05-10 at 12 01 39 PM" src="https://github.com/user-attachments/assets/58435989-ec3d-4d08-a956-7422126e6e8b" />
