# Code Previews architecture

Code Previews owns tool presentation: syntax highlighting, diffs, warnings, appearance settings,
and the cooperative shell. Pi owns native execution, tool discovery/activation, MCP connections,
permissions, and result storage. The module map is descriptive; renderer ownership and evidence
preservation are the constraints a refactor must retain.

## Ownership and boundaries

| Area                                                                                                   | Responsibility                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [Application](src/application/lifecycle.ts) and [Layer](src/layer.ts)                                  | Session runtime, trusted startup, presentation readiness, replacement, shutdown |
| [Renderer resolver](src/application/tool-renderers.ts) and [admission](src/tools/preview-admission.ts) | Exact public-source admission and renderer-only composition                     |
| [Replay bridge](src/application/owned-replay.ts) and [retained row](src/application/renderer-row.ts)   | Historical rows and originating-owner readiness/appearance                      |
| [Configuration store](src/config/store.ts)                                                             | Settings persistence and atomic publication across runtime instances            |
| [Syntax](src/syntax/) and [write](src/write/)                                                          | Scoped highlighter acquisition and actual before-write evidence                 |
| [Preview shell](src/preview/) and [tool projectors](src/tools/)                                        | Synchronous rendering, semantic summaries, bounded evidence, fallback           |
| [Third-party registry](src/third-party/registry.ts)                                                    | Explicit, independently admitted external renderer adapters                     |

Public APIs and integration examples live in [extension authors](docs/extension-authors.md).
The [reference](docs/reference.md) documents user settings; the
[tool presentation standard](../../docs/architecture/tool-presentation.md) owns shell/issue policy.

## Host ownership and replay

The extension installs one public `pi.registerToolRenderer` resolver at factory time. It reads only
public renderer callbacks from `next()` and admits native tools through exact public source metadata.
A matching name is insufficient; ambiguous metadata declines. Historical MCP aliases require an
independently proven native manager. The `tool_search` source path is `builtin:tool-search`, which
intentionally differs from its tool name. Unsupported tools fall through unchanged.

The resolver must not compose native factories, replace `/mcp`, register execution definitions,
or alter tool selection. The sole execution exception is
[write's before-write hook](src/tools/renderers/registration.ts): it captures real evidence while
preserving Pi's mutation queue, direct-write behavior, and activation. An inactive hook delegates
natively without recording a snapshot. Attempted ownership and successful installation remain distinct
so a host refresh failure after registration can be retried without taking over a foreign tool.
The [write boundary note](docs/host-write.md) explains its queue and cancellation handoff.

Session startup loads trusted settings before publishing a presentation owner and its scheduler.
Readiness belongs to that originating owner. Cold historical rows can adopt its first-ready appearance
and reconstruct complete arguments/results, but cannot execute a tool, load settings, or borrow a
replacement session's scheduler. Deactivation revokes capabilities immediately; runtime disposal
awaits scoped scheduler work. Syntax initialization can fall back to plain text without taking down
presentation.

Deferred and lazily created diff previews capture their originating capability and display limits.
If that owner retires before computation or first draw, they render retained evidence as plain text
without scheduling work, requesting syntax resources, or invalidating the previous host.

Cooperating extensions retain their own executable registrations. They install
`registerCodePreviewReplay` at factory time, wrap through its `shell` after settings load, publish
only after successful registration, finish pending startup on settlement, and retire on shutdown.
`withCodePreviewShell` preserves an owned execution definition; `withCodePreviewRenderers` handles
renderer-only composition. Shell mode and collapsed style are captured when wrapping.

Third-party support stays behind the isolated registry, with exact package/source/name admission.
Adapters never import providers, inspect executions, change activation, or read stored artifacts.
They preserve downstream components and append full raw evidence because an external renderer may
truncate its own expanded content. See [adapter maintenance](docs/third-party-renderers.md).

## Settings and state

The configuration store is the persistence entrypoint; pre-session access uses a short-lived boundary
runtime. A process-local coordinator serializes operations across independently built Layers. Only
successful work advances publication authority. Atomic document modification, private replacement,
and settings projection publication commit together; flush is a global barrier.

Settings resolution ignores untrusted projects, preserves valid sibling fields after malformed input,
and reports ignored files/invalid fields. Saves modify only known edited overrides in the latest
locked document, preserving unrelated fields and publishing its resolved values. Reset removes known
overrides. Failed UI edits cannot undo later successful edits. Save follow-up retains its invoking
session's authority; retirement prevents panel updates, notifications, or replacement-session syntax
initialization. Syntax initialization failure cannot roll back a committed theme.

Syntax and write services own resources and authoritative state; renderers consume synchronous
projections. Bounded, scoped syntax requests remember failed grammars/themes for the session rather
than retrying on every draw. Ownership tokens prevent late cleanup from clearing newer caches or
write evidence. Renderer-local caches, frame state, and component state may be mutable; they are
presentation state, not a second owner of execution or session resources.

## Evidence and failure behavior

Unknown host values are decoded at their boundary before projection. Native dispatch/result evidence
is bounded and conservative: missing coverage is uncertainty, non-error delivery is not proof of
domain success, and unknown write history is not proof of a new file. Codemode's parsed discovery
hints describe source intent, separately from observed native dispatch. Rendering never reads saved
output or spill files.

The shell preserves exact arguments, full output/recovery text, and native images through expansion.
Original and content-only slots keep independent caches. A failed callback falls back to raw evidence
without replaying that callback. Long-lived components retain the state they need, not a render
context whose previous-component pointer would retain earlier rows. Pi continues to own images and
transcript separators. Issues use the shared human message plus expanded diagnostic detail in both
appearance modes.

## Verification

[Lifecycle](tests/application/lifecycle.test.ts),
[renderer replay](tests/application/renderer-replay.test.ts),
[owned replay replacement](tests/application/owned-replay-replacement-sdk.test.ts), and
[settings concurrency](tests/config/service.test.ts) tests protect ownership and cleanup.
[Write execution](tests/write/preview-execution.test.ts) and
[native codemode SDK](tests/application/native-codemode-sdk.test.ts),
[tool-search SDK](tests/application/native-tool-search-sdk.test.ts), and
[MCP SDK](tests/application/native-mcp-sdk.test.ts) tests check the real host boundary.
Use `pi-code-previews/testing` for presentation behavior and `pnpm presentation:gallery` for visual
review; neither presentation rendering nor replay should execute a tool.
