# pi-code-previews

Syntax-highlighted previews for pi's built-in tool calls.

The package publishes TypeScript source and runs directly through Pi's Jiti loader; it has no generated distribution or build prerequisite.

`pi-code-previews` makes `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` output easier to scan in the pi TUI without changing what the tools do. If another extension already owns one of those tools, `pi-code-previews` skips that preview instead of conflicting with it. It installs configured renderer replacements but never enables, disables, or reorders Pi's active tool names.

## Features

- Distinct emoji labels and syntax-highlighted previews for commands, files, diffs, and search results.
- Clearer `edit` and `write` diffs, including pending edit previews.
- Readable `grep` results grouped by file.
- Compact `find` and `ls` path lists with optional icons.
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

Open settings inside pi with:

```text
/code-preview-settings
```

Check status with:

```text
/code-preview-health
```

The health panel shows configured tools, installed replacements, registration errors, disabled tools, and replacements skipped because another extension owns that tool. Individual tool toggles are available in the Preview tools submenu in `/code-preview-settings` and take effect after `/reload`.

Renderer installation is best effort after planning completes. A discovery or definition-construction failure stops startup before registration begins. If one `registerTool` call fails, later replacements are still attempted and successful replacements keep a live session runtime. Attempted names and successful installs are tracked separately, so a Pi 0.84 refresh failure after registry mutation remains retryable on the next session start. There is no rollback of successful installs.

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

You can also choose **Collapsed tool calls** under **Appearance** in `/code-preview-settings`, or start Pi with `CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE=compact`. The default is `preview`, which keeps the existing presentation. The wrapper captures this setting at tool registration; changes require `/reload`.

In compact mode, ordinary collapsed calls use one extension-rendered text row while arguments arrive, during execution, and after settlement. The row prioritizes the status glyph, tool name and optional action, then the target subject and whole counter tokens. Counters are admitted in provider order. With long subjects they use at most half the remaining terminal cells while preserving up to 12 subject cells; short or empty subjects let counters use otherwise unused space. Long subjects use grapheme-safe middle elision to retain both ends. Metadata uses slack only after the complete subject and admitted counters; measured duration and the hidden-details hint use any space left after that. Optional fields disappear before the identity is clipped at very narrow widths. Counters are never partially displayed. Status uses shared icons instead of words. The running icon animates even when `toolCallTiming` is off; it stops after settlement or session shutdown. With timing off, expansion pauses the hidden icon's animation and collapsing resumes it. Pending calls have no execution duration, and restored calls do not gain a fabricated duration.

Ordinary live output and pending write/edit previews stay hidden until expanded. Failures show one header and an indented cause, without the old error card or duplicate error text. Known filesystem and command-status errors get short causes; unrecognized error text stays intact rather than hiding possible recovery instructions. Cancellation uses neutral styling and uncertain outcomes use amber. Important warnings and recovery instructions remain visible and may need extra rows. Routine read-range and known line-pagination hints stay in the original output and expanded details, not compact warning rows. Routine grep/find/ls result caps use a quiet `limit reached: N` counter, prioritized over optional metadata and timing/disclosure hints. A reached cap does not establish a total, additional results, or how many survived output truncation. Successful writes use `diff skipped: size` or `diff skipped: complexity` metadata only for structured size evidence or computed guards with known previous contents. Missing history, non-regular previous paths, unclassified skip reasons, missing edit diffs, and secrets still receive attention. Byte caps, partial grep lines, oversized-line recovery, and unknown truncation also remain warnings or recovery rows. Original tool results and expanded continuation instructions are unchanged. Expansion shows complete failure text once, or restores the original detailed presentation for other results, with the configured `toolCallBackground`. Compact mode takes precedence over per-tool collapsed-preview toggles and line limits; those retain their existing meaning in `preview` mode. `toolCallTiming` remains independent.

Compact rendering covers only installed replacements for `read`, `bash`, `write`, `edit`, `grep`, `find`, and `ls`. It does not activate disabled tools or replace tools owned by another extension. Cooperative tools without an explicit compact-summary provider keep their current rendering. Pi's host-owned blank separator remains, and Pi still renders native images outside the extension's text-row budget.

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

`CODE_PREVIEW_TOOL_CALL_TIMING=false` hides tool durations. When enabled, measured durations appear inline in compact summaries. Detailed rendering uses the result footer unless `toolCallBackground` is `border`; in border mode durations appear in the top-right border corner.

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
`undefined`, allowing the caller to keep a neutral fallback.

### Compact summaries

Workspace integrations include MCP, subagents, Code Mode, background tasks, questionnaires, and image generation. Each supplies its own semantic summary; `loadCodePreviewSettings` alone does not change rendering. Unsafe or incomplete results retain their existing details, including subagent recovery/report cards and MCP uncertainty. Code Mode keeps the original completed view for nested MCP/Background Tasks calls because its activity records do not retain their domain outcomes. Child-only text acknowledgements and parent-message tools remain unmodified.

Cooperative animation also requires `scheduleAnimation` from the registering extension's session. Pi isolates extension module instances, so loading settings cannot activate another extension's scheduler. Compose `CodePreviewSchedulerService.layer` into the owner's runtime, pass its `schedule` callback through the shell options, and reject scheduling after that session is replaced. Runtime disposal cancels every remaining animation. Built-in previews use their own scheduler by default.

A cooperative tool opts in by passing `compactSummary` to `withCodePreviewShell`. The callback receives `{ phase, args, result, context }` and returns plain semantic data: a target or intent `subject`, optional `action`, optional `counters` and `metadata` string arrays, optional `outcome`, and optional `notices`. Classify counters in the provider rather than parsing metadata strings. Keep an action separate only when the tool name does not already identify it. Outcomes are `success`, `warning`, `error`, `cancelled`, or `uncertain`; notices have `{ kind: "warning" | "error" | "recovery", text }`. A settled summary must state its outcome explicitly. Optional `failure: { cause, details }` grants the shell ownership of a failed, cancelled, or uncertain result's text presentation. `cause` is the collapsed explanation; `details` must contain the complete error text, including all continuations. Preserve unfamiliar recovery text in the cause or notices rather than guessing which lines can be hidden. Notices must contain independent safety or recovery information, not another copy of the error. Expansion replaces the cause with complete details and omits notices already present verbatim in that text. Without `failure`, non-success outcomes retain their original renderer and supplementary notices unless the provider explicitly sets `detailsOnExpand: true`. That flag promises the provider has decoded the result and completely projected collapsed attention and recovery information into `subject` and `notices`. The collapsed view then shows the header and notices; expansion restores the original call/result renderers. An owned `failure` still takes precedence. Unknown or malformed results must decline compaction, not set the flag. Warning and recovery notices use the same ` ╰─` indentation as error causes, with aligned wrapped continuations. At narrow widths indentation yields to the text. Returning `undefined` or throwing declines compaction and preserves the detailed rendering. Tools without a provider keep their current rendering, and `preserveSelfShell` still protects tools that own their shell.

Expansion ownership is optional and conservative. A notice may set `expandedInResult: true` only if the original expanded result renders that complete notice. A summary may set `expandedResultOwnsCall: true` only if that result includes all call information, not merely a similar title. These flags take effect only after the current original result renderer succeeds. Unknown results, failed factories, and independent recovery retain their text. Owned failures ignore these flags. Retained notices stay inside the selected expanded frame or background. Never use call ownership to hide program source, paths, tasks, or input diffs.

This example assumes `reportTool` takes a `path` argument. Its domain contract puts every warning and recovery instruction in `details.notices`, and `details.status === "ok"` means the work completed successfully. The provider leaves streaming results and all unrecognized or non-clean reports uncompacted. Register the wrapped tool after loading settings, as above.

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
        !("notices" in details) ||
        !Array.isArray(details.notices) ||
        details.notices.length !== 0
      )
        return undefined;

      return { subject, outcome: "success" };
    },
  }),
);
```

Use your tool's authoritative domain result to distinguish success, warnings, cancellation, and uncertainty. `context.isError === false` alone does not prove success. Discover important notices independently of preview-body rendering; do not flatten components, take their first line, or inspect ANSI colors to build summaries. The wrapper changes presentation only and preserves execution, tool schemas, prompt metadata, and result contents.

### Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Install it as a runtime dependency with the package manager this project uses, e.g. `npm install pi-code-previews`. Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode and collapsed style, so load settings before wrapping and re-register tools on /reload. Do not wrap tools owned by other extensions. Run checks.
```

## Screenshots

<img width="1053" height="368" alt="Screenshot 2026-05-10 at 12 01 39 PM" src="https://github.com/user-attachments/assets/58435989-ec3d-4d08-a956-7422126e6e8b" />
