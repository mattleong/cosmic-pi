# Pi 1.0 API compatibility audit

## Scope

The Pi catalog moved from 0.99.0 to 1.0.0 (`pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-codemode`). This audit covers the 0.99.1, 0.99.2, and 1.0.0 changelog entries. It also compares the installed 0.99.0 and 1.0.0 `dist` trees: extension types, interactive custom UI, `pi-tui` overlays and layout, codemode, the MCP extension, the session tool loadout, settings, CLI arguments, and `pi-ai`.

After the bump, every package typechecked. The full suite passed after one fixture fix: codemode `image()` now validates real image data. Passing checks did not catch the two presentation regressions fixed below.

## Extension API

- `types.d.ts` gained only `ToolNamespace.instructions`. `description` is now a short listing summary, and `describeNamespace()` returns `instructions`. The workspace's only namespace, `subagents`, has a one-line description.
- New: `QuietStartup` (`boolean | "header"`) and `ModelRegistry.generateImages()`.
- `registerCommand` now throws when the name or handler is missing. TypeScript already enforces both.
- `registerMcpServer` now rejects names that clash once `-` becomes `_`.
- No workspace code reads `quietStartup` or `tuiMode`, or registers MCP servers.

## Fullscreen by default

These behaviors are unchanged from 0.86 through 1.0.0:

- `showExtensionCustom` calls the factory synchronously inside `custom()`, and a throw rejects the Promise.
- Mounting happens in a later microtask: `showOverlay` plus `onHandle`, or the editor slot.
- `done` calls `hideOverlay()`, which pops the top overlay, and then disposes the component.
- An `overlayOptions` callback runs once, at mount. The TUI keeps that options object and reads its properties on every render.
- `setExtensionWidget` changed only cosmetically, and `renderWidgets` is unchanged.
- The `pi-tui` overlay stack and handles are unchanged, apart from focus retention for forwarded mouse events.

Factories receive a stable proxy that forwards to the current renderer, and Pi refuses to switch TUI mode while overlays are open. `fakeCustomSurfaceHost` and the guarded owned-surface close therefore remain accurate. Fullscreen transcript search opens its own overlay through a handle, and the guarded close also protects it.

Layout did change:

- Widgets, the editor slot, and the footer sit in a bottom dock that shrinks to fit the terminal. The transcript keeps at least one row and the editor at least three.
- A component taller than its share is clipped from the bottom, except that the visible window follows a line carrying the cursor marker.
- All above-editor widgets share one dock entry, so later widgets lose rows first.
- In regular mode, overflow scrolled the top of the content into scrollback instead.
- Screen and overlay placements still compose over the whole terminal.

Ask User's external editor uses Pi's own Ctrl+G sequence: `stop()`, then `start()` and `requestRender(true)`. Herdr BTW launches the user's Pi, so side sessions run fullscreen unless `tuiMode` is `"regular"`.

## Native MCP (0.99.2)

**Names.** Every character outside `[A-Za-z0-9_]` in a tool name now becomes `_`. Namespaces are `mcp__<server>` with `-` replaced by `_`. Labels and result `details` keep the configured server name.

- **Fixed:** `pi-mcp-previews` matched the label against the namespace verbatim. Dashed servers therefore lost the `server / tool` heading and fell back to the raw label. `nativeMcpIdentity` now accepts either namespace form. A test was added, and the fixture mirrors 1.0 names.
- `pi-code-previews` nested rows parse registered names. 1.0 names show the sanitized server; older dashed names still parse.

**Exposure and connection.** Default `codemode` exposure now gives tools `deferred` exposure, so they are left out of the codemode description. `codemode-deferred` is an alias.

- Servers are listed in an `mcp_servers` system prompt section written at `before_agent_start`.
- The first prompt waits only for servers with `direct` tools.
- A new `tool_call` handler waits for the servers a codemode script names. It recognizes codemode by schema identity.
- `pi-mcp-previews` buffers handlers for any event and passes their results through. The new handler and the prompt section therefore work unchanged, and no code reads exposure.
- The `pi-code-previews` replacement keeps the native `codemodeSchema` object; its `installed` status already requires this. Pi's MCP manager therefore still activates the styled codemode, and the new wait also applies to it.

## Native codemode (1.0)

- The description is shorter. Direct tools get a one-line `Codemode: tools.x(args) resolves to …` note instead of full declarations. No workspace code depends on these strings.
- Reading a missing `tools` or global-namespace member now throws, so scripts must test with `"name" in tools`. No workspace script used `typeof tools.x`; the migration guide now says so. The rule applies to every `CodemodeSandbox` namespace. The `pi-subagents` workflow prelude reads only defined `__workflow` members.
- `image()` validates base64 data and the image signature, and ignores the declared MIME type.
- **Fixed:** `models.generateImages` adds nested rows whose arguments are a plain `provider/id`. `pi-code-previews` handled that form only for `models.classify`, so image rows reported that the argument preview was unavailable. A test and a gallery row were added.
- The call record and the outer header are unchanged.

## Session tool loadout (0.99.2)

On reload and resume, restored tools stay pending until they are registered. Any `setActiveTools` call that deactivates a tool clears every pending name. `/reload` activates tools newly added to `defaultTools`. `pi-code-previews` only registers tools and never changes the active set.

## Other checks

- `--provider` without `--model` now fails. No workspace launcher passes `--provider`: Herdr BTW passes `--session` and `--name`, and Subagents pass `--model`. Directory Models' detection of an explicit preference is unaffected.
- The virtual-model selection lookup was rewritten for speed and gives the same result.
- The `openai-codex` default became `gpt-6.1-sol`. Better OpenAI's image default, `gpt-5.5`, is still in the catalog.
- In `pi-ai`, Responses replay drops item IDs that do not match `fc_`/`ctc_`, and Anthropic falls back from strict schemas. No workspace code depends on either.
- Pi creates new session files at the first user or assistant message. The Herdr BTW comment was corrected.

## Documentation updated

- `docs/architecture/pi-boundaries.md`: version claims re-verified for 1.0.0; fullscreen dock note added.
- `docs/architecture/testing.md`: re-verified the version claim for 1.0.0.
- `docs/migrations/native-mcp-codemode.md`: name normalization, `mcp_servers`, `"name" in tools`.
- `pi-mcp-previews` and `pi-code-previews` READMEs, and a `pi-code-previews` test comment.

Historical plans and reviews keep the versions they were written against.

## Follow-ups outside this change

**pi-cosmic-ui**

- Replace "pinned Pi 0.86" with "unchanged from 0.86 through pinned 1.0.0". Affected: the `src/testing/custom-surface.ts` doc comment, the `src/boundary/host-viewport.ts` comment, the README, and `ARCHITECTURE.md`. Each claim was verified above.
- Check fullscreen clipping in a real terminal. The `dock` input widget, about 60% of rows, renders after the Activity widget, so its bottom rows are clipped first. Inline settings surfaces in the editor slot are also bounded by the dock.

**pi-subagents**

- `application/register.ts` `onActivated` registers the tools, then `deactivateSubagentTools` removes them. During `/reload`, Pi has just re-activated those pending tools, so the removal clears every pending name. That drops restored tools, such as `tool_search`-loaded MCP tools, whose servers have not reconnected yet: the 0.99.2 fix this undoes. The same applies to any other `setActiveTools` removal during startup.
- `docs/local-backends.md` cites Pi 0.84–0.86 behavior; re-verify it before restating it for 1.0.0.

## Open items from the 0.99 audit

These items were not re-verified at runtime in this pass:

- **Moot:** the Code Mode Bash failure, because `pi-code-mode` is retired. The Herdr virtual-auth readiness item, because Herdr support was removed from Subagents. Custom MCP interoperability, because `pi-mcp` is retired.
- **pi-subagents:**
  - RPC input dispositions: no decoding in `backend/local-pi.ts`.
  - Blocking `contact_parent` still has the default `direct` exposure.
  - Context-edit replacements are not sanitized for thinking in forks.
- **Better OpenAI:**
  - Usage authentication still reads only `openai-codex`.
  - Fast mode and image generation do not account for virtual selections.
- **Cosmic UI and Better xAI:** settings headings do not react to theme changes.
- **Ask User:** the tool exposure policy is still undecided.
