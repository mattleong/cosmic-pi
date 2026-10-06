# pi-code-previews

Syntax-highlighted, easier-to-scan tool output in the Pi TUI. Code Previews restyles builtin, native codemode, tool search, and MCP calls without changing what the tools do, and gives other extensions the same tool shell.

## Features

- **Builtin previews** for `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`: syntax highlighting, clearer diffs (including pending edits), grep results grouped by file, and compact path lists with optional icons.
- **Native tool presentation** for `codemode` programs and their nested calls, `tool_search` queries, and MCP tool and resource calls, including progress and images.
- **Warnings** for risky-looking shell commands and secret-looking output.
- **Compact style** (opt-in) that collapses each call to a single row until expanded.
- **Call timing** inline, in result footers, or in the border frame.
- **Themes and limits:** Shiki theme, background or border frame, line counts, icons, and word-level diff emphasis.
- **Third-party support** for `pi-web-access` tools.
- **Reusable tool shell** so other extensions' tools look and collapse the same way.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-code-previews"
```

Requires Pi 1.0.1 or later; tested with Pi 1.0.2. If you previously installed the standalone `pi-mcp-previews`, remove it manually with `pi remove` and the source `pi list` shows for it (add `-l` for project installs), then reload. See the [migration guide](../../docs/migrations/native-mcp-codemode.md).

## Usage

Previews apply automatically. Press `Ctrl+O` (Pi's expand binding) to see a call's full input and output.

| Command                                | Action                                           |
| -------------------------------------- | ------------------------------------------------ |
| `/code-previews settings`              | Open settings; `help` and `status` also work     |
| `/code-previews settings <id> <value>` | Change one setting                               |
| `/code-previews health`                | Show which previews are active and any conflicts |

If another extension already owns a builtin tool, Code Previews leaves that tool alone. Turning a preview off changes only its styling, never whether the tool is available.

### In your own extension

Wrap your extension's own tools with the shell after loading trusted settings, and list `pi-code-previews` as a runtime dependency:

```ts
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";

pi.on("session_start", async (_event, ctx) => {
  await loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted());
  pi.registerTool(withCodePreviewShell(myToolDefinition));
});
```

See [docs/extension-authors.md](docs/extension-authors.md) for compact summaries, issues, renderer-only integration, and testing helpers.

## Configuration

Global settings live in `~/.pi/agent/code-previews.json` (or `$PI_CODING_AGENT_DIR/code-previews.json`). Defaults can also go under `codePreview` in Pi's `settings.json` or a trusted project's `.pi/settings.json`. In order of increasing priority: built-in defaults, global `settings.json`, project `settings.json`, then the flat keys in `code-previews.json`.

For example, in a trusted project's `.pi/settings.json`:

```json
{
  "codePreview": {
    "shikiTheme": "dark-plus",
    "toolCallBackground": "border",
    "toolCallCollapsedStyle": "compact",
    "toolCallTiming": true,
    "tools": ["bash", "read", "write", "edit", "grep", "find", "ls", "codemode", "tool_search"]
  }
}
```

`toolCallCollapsedStyle` is `preview` by default; `compact` gives one-row calls. Changes to the frame, collapsed style, and preview tool list take effect after `/reload`.

## How it works

Code Previews registers one tool-renderer resolver when it loads. The resolver adds presentation to tools whose public metadata identifies them as Pi builtins or a supported third-party package, so Pi keeps sole ownership of execution, tool selection, codemode, MCP, and `/mcp`. The one exception is `write`, which keeps a before-write hook so it can diff against the previous file. Each Pi session owns a scoped Effect runtime for syntax loading, animation, and settings I/O. Problems appear as short, consistent issue lines; full detail stays available on expansion.

See [docs/reference.md](docs/reference.md) for native tool behavior, compact-mode rules, and every setting, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.

<img width="1053" height="368" alt="Code Previews showing highlighted tool calls in the Pi TUI" src="https://github.com/user-attachments/assets/58435989-ec3d-4d08-a956-7422126e6e8b" />
