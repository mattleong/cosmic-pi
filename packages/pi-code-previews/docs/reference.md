# pi-code-previews reference

Detailed presentation, configuration, and native-tool behavior behind the [README](../README.md). The [tool presentation standard](../../../docs/architecture/tool-presentation.md) is the normative contract for admission, issues, expansion, and timing; this file adds only what it and [ARCHITECTURE.md](../ARCHITECTURE.md) don't cover. See [extension-authors.md](extension-authors.md) for the public integration API and [third-party-renderers.md](third-party-renderers.md) for the `pi-web-access` adapter.

## Settings commands and health

The `/code-previews health` panel shows configured tools, available renderer presentation, write registration errors, unavailable tools, disabled previews, foreign-owner conflicts, and native MCP renderer availability. Individual builtin/codemode/tool-search preview toggles are available in the **Preview tools** submenu of `/code-previews settings`. `codemode` and `tool_search` are included in the default preview-tools selection; existing explicit `tools` lists must add them to opt in.

Public metadata is rechecked when choosing renderers. Resolver precedence follows Pi's extension load order, without execution registration conflicts. Startup ordering, replay, and write's execution hook are covered in [ARCHITECTURE.md](../ARCHITECTURE.md#lifecycle-and-boundaries).

## Native tool search

Foreign, inline, duplicate, and missing ownership never gain native semantic presentation; see [registration and policy](../../../docs/architecture/tool-presentation.md#registration-and-policy) for admission.

Collapsed rows show a bounded query and **N tools listed** from a valid native `details.loaded` receipt, including zero.

Pi alone owns the native tool's inactive-by-default, model-only exposure. Native search can find and activate inactive deferred/codemode tools; rendering or replaying a search never does so.

## Native codemode

Code Previews chooses native `codemode` renderers only when public source metadata identifies `builtin:codemode`. Later MCP activation gets presentation without `/reload`.

Pi retains parameter schemas, grammar, prompt metadata, live `codemode.mode`/`inlineBudget`, model access, nested permission hooks, cancellation, and branch-scoped `store()`/`load()` behavior.

Cancelled/unsettled children leave the overall outcome unconfirmed. A native failure header remains a failure: guest-controlled error names and stacks cannot prove cancellation, so abort diagnostics are retained without asserting a typed stop reason. Complete leading paths and targets survive later JSON truncation; cut string values carry an ellipsis. MCP and background-task rows show observed actions and targets, never inferred fields beyond the preview.

Direct unshadowed `searchTools`, `describeTool`, and `describeNamespace` calls add a **tool discovery** hint. An explicit static MCP tool target or `namespace: "mcp__…"` adds **MCP discovery** instead. Comments and strings stay unclassified, and model dispatches retain the generic call counter. The remaining discovery rules are in the [presentation standard](../../../docs/architecture/tool-presentation.md#registration-and-policy).

Native MCP calls inside Code Mode show readable `mcp call server / tool` rows from unambiguous registered `mcp__*` aliases, including short collision-hash suffixes. Resource read/list/template targets that are cut carry an ellipsis. This uses the existing `codemode` preview toggle.

Call evidence, collapsed limits, expansion order, and timing follow the [presentation standard](../../../docs/architecture/tool-presentation.md#registration-and-policy).

## Standalone native MCP

Standalone native MCP previews share Code Previews' appearance settings and session-owned scheduler. Previously persisted `nativeMcpPreviews` fields are inert unknown data, preserved by ordinary saves. Admission, ownership, and saved-output handling are in the [presentation standard](../../../docs/architecture/tool-presentation.md#registration-and-policy).

## Configuration

File locations and precedence are in the [README](../README.md#configuration). Invalid fields retain the preceding value. A choice in the settings panel applies globally: the panel removes an override only when every project would then inherit the chosen value. **Restore defaults** removes the panel's overrides, so values from `settings.json` and the built-in defaults apply again. See [settings and durable publication](../ARCHITECTURE.md#settings-and-durable-publication) for trust, persistence, and error reporting.

### Compact collapsed calls

You can also choose **Collapsed tool calls** under **Appearance** in `/code-previews settings`.

In compact mode, ordinary collapsed calls use one extension-rendered text row while arguments arrive, during execution, and after settlement. The row prioritizes the status glyph, tool name and optional action, then the target subject and whole counter tokens. Counters can offer a shorter fallback such as `3 failed` for narrow rows; without counters, the first nonempty metadata item is selected. Counters can use the remaining terminal cells while preserving up to 12 subject cells. Long subjects yield space to whole progress counters before those counters are dropped. Long subjects use grapheme-safe middle elision to retain both ends. When no counter or metadata is present, enabled timing appears once a call has run for at least one second. Counts take priority when both cannot fit. Compact rows omit the expand hint. Optional fields disappear before the identity is clipped at very narrow widths. Counters are never partially displayed. The running icon animates even when `toolCallTiming` is off; it stops after settlement or session shutdown. With timing off, expansion pauses the hidden icon's animation and collapsing resumes it. Pending calls have no execution duration, and restored calls do not gain a fabricated duration.

Ordinary live output and pending write/edit previews stay hidden until expanded. Known filesystem and command-status errors get short messages ("File not found", "Exited with code 1"). Routine read-range and known complete-line pagination hints, including read byte caps, appear only when expanded. Byte-cap hints require a recognized numeric size-limit footer and explicit evidence that the final returned line is complete. Routine grep/find/ls result caps use a quiet `limit reached: N` counter, prioritized over optional metadata and timing. A reached cap does not establish a total, additional results, or how many survived output truncation. Successful writes use `diff skipped: size` or `diff skipped: complexity` metadata only for structured size evidence or computed guards with known previous contents. Missing history, non-regular previous paths, unclassified skip reasons, and missing edit diffs are informational, since they concern the preview rather than the change; possible secrets are warnings. Other byte caps, partial lines, oversized-line recovery, and unknown truncation are warnings too. Compact mode takes precedence over per-tool collapsed-preview toggles and line limits; those retain their existing meaning in `preview` mode. `toolCallTiming` remains independent.

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

Preview writes retain Pi's direct-write semantics so symlinks, hard links, open descriptors, file modes, and inode identity behave like the built-in write tool.

In `preview` style, when content/result/diff previews are disabled, collapsed successful output or code previews are hidden while the tool call stays visible; use pi's expand shortcut to view them on demand. `writeContentPreview: false` hides collapsed write content and write diffs, and `editDiffPreview: false` hides collapsed proposed/applied edit diffs. `bashResultPreview: false` applies to all successful `bash` output, while grep/find/ls result toggles also hide matching `bash` commands that start with `grep`, `find`, or `ls`.

For expanded calls and noncompact fallbacks, `toolCallBackground: "off"` removes the colored background from Code Previews presentations. `toolCallBackground: "border"` replaces the background with a border-only frame.

`toolCallTiming: false` hides tool durations, including measured durations in nested compact call trees. Measured durations appear inline in compact summaries. Detailed rendering uses the result footer unless `toolCallBackground` is `border`; in border mode durations appear in the top-right border corner.

## Benchmarks

From a source checkout, diff/edit rendering benchmarks are available for local performance checks:

```bash
pnpm bench:recommended
```

Individual suites cover diff wrapping, edit renderer previews, write/edit diff generation, and word-emphasis/pathological changed-line pairing. See [word-emphasis.md](word-emphasis.md) for word-emphasis accuracy notes, confidence scoring, telemetry, the golden-corpus workflow, and its accuracy and pathology commands.
