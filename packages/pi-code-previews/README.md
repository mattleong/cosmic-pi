# pi-code-previews

Syntax-highlighted previews for pi's built-in tool calls.

`pi-code-previews` makes `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` output easier to scan in the pi TUI without changing what the tools do. If another extension already owns one of those tools, `pi-code-previews` skips that preview instead of conflicting with it.

## Features

- Distinct emoji labels and syntax-highlighted previews for commands, files, diffs, and search results.
- Clearer `edit` and `write` diffs, including pending edit previews.
- Readable `grep` results grouped by file.
- Compact `find` and `ls` path lists with optional icons.
- Optional visual warnings for risky-looking shell commands and secret-looking output.
- Tool call duration timing in result footers or border frames.
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

The health panel shows configured tools, active previews, disabled tools, and previews skipped because another extension owns that tool. Individual tool toggles are available in the Preview tools submenu in `/code-preview-settings` and take effect after `/reload`.

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

### Project settings

You can set defaults in `.pi/settings.json`:

```json
{
  "codePreview": {
    "shikiTheme": "dark-plus",
    "wordEmphasis": "all",
    "toolCallBackground": "border",
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

When content/result/diff previews are disabled, collapsed successful output or code previews are hidden while the tool call stays visible; use pi's expand shortcut to view them on demand. `CODE_PREVIEW_WRITE_CONTENT=false` hides collapsed write content and write diffs, and `CODE_PREVIEW_EDIT_DIFF=false` hides collapsed proposed/applied edit diffs. `CODE_PREVIEW_BASH_RESULTS=false` applies to all successful `bash` output, while grep/find/ls result toggles also hide matching `bash` commands that start with `grep`, `find`, or `ls`.

`CODE_PREVIEW_TOOL_CALL_BACKGROUND=off` removes Pi's default colored tool box background for code-preview-owned tools. `CODE_PREVIEW_TOOL_CALL_BACKGROUND=border` replaces the background with a border-only frame. This setting changes the tool render shell, so it takes effect after `/reload`.

`CODE_PREVIEW_TOOL_CALL_TIMING=false` hides tool durations. When enabled, durations appear in the result footer unless `toolCallBackground` is `border`; in border mode they appear in the top-right border corner.

## Extension author integration

Other pi extensions can opt their own tools into the code-preview shell by importing `withCodePreviewShell`. The wrapper captures shell mode when it is called, so project-aware consumers must load trusted project settings before wrapping and registering the tool inside `session_start`:

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
does not change that tool's `renderShell`; wrap/register it only after the desired settings load.

If an extension imports `pi-code-previews`, it should list it in `dependencies` so users do not
need to install it separately.

### Prompt for extension authors

Give this to an agent working on another pi extension:

```text
Add pi-code-previews support to this extension. Install it as a runtime dependency with the package manager this project uses, e.g. `npm install pi-code-previews`. Import `withCodePreviewShell` and `loadCodePreviewSettings` from `pi-code-previews`. For trusted project settings, inside `session_start` first call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())`, then wrap this extension's own tool definitions with `withCodePreviewShell(...)` and register them. The wrapper captures shell mode, so do not claim a later reload changes `renderShell`. Do not wrap tools owned by other extensions. Run checks.
```

## Screenshots

<img width="1053" height="368" alt="Screenshot 2026-05-10 at 12 01 39 PM" src="https://github.com/user-attachments/assets/58435989-ec3d-4d08-a956-7422126e6e8b" />
