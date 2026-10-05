# Migrate to native Pi MCP and codemode

Cosmic Pi `0.2.0` retires `pi-mcp`, `pi-code-mode`, and the standalone `pi-mcp-previews` package. Code Previews includes builtin/native codemode/MCP presentation through the public renderer-only API; it requires Pi **1.0.1 or later**, tested with **1.0.2**. Pi now owns MCP configuration, authentication, connections, execution, tool exposure, and native `codemode`. There is intentionally no compatibility layer.

## Replace the extensions

1. Uninstall the old extensions from every scope where they were installed. Use `pi remove npm:pi-code-mode` for the published extension, or `pi remove /absolute/path/to/packages/pi-code-mode` and `pi remove /absolute/path/to/packages/pi-mcp` for local installs. Add `-l` for project-local installations. Remove any remaining explicit old extension paths from Pi settings.
2. If standalone `pi-mcp-previews` was installed, **remove it manually from every scope**: `pi remove npm:pi-mcp-previews`, or `pi remove /absolute/path/to/packages/pi-mcp-previews` for a local install. Add `-l` for project-local installations. Use `pi list` to find the exact source and remove any remaining explicit extension paths yourself. The old adapter replaces `/mcp`; leaving it installed prevents the independent builtin manager from owning native MCP.
3. Upgrade Pi to at least 1.0.1 (the workspace tests 1.0.2). Keep or install `pi-code-previews` with `pi install npm:pi-code-previews`, or `pi install "$PWD/packages/pi-code-previews"` for a checkout with dependencies installed. Add `-l` only for project-local installation. It now includes the generic shell, builtin previews, native codemode, and standalone native MCP presentation.
4. Remove obsolete `-builtin:mcp` exclusions that previously disabled native MCP for the custom gateway. Remove custom `-builtin:codemode` exclusions if they were only there for the retired extension. Preserve deliberate user restrictions; do not enable every tool or replace your allowlist indiscriminately.
5. Run `/reload` or restart Pi after changing installation or configuration.

Code Previews registers one stable `pi.registerToolRenderer` resolver at factory loading. It neither composes nor intercepts native codemode/MCP factories, registers their execution definitions, replaces `/mcp`, nor changes tool selection/exposure or permission gates. Write alone retains a genuine before-write snapshot hook under Pi's mutation queue. Extension-owned questionnaire/task/subagent/image tools retain their normal executable registrations.

Standalone MCP presentation has no startup toggle and follows Code Previews' appearance settings. The former `nativeMcpPreviews` preference remains inert unknown data, preserved by ordinary saves; remove it manually if desired. The builtin/codemode preview-tools list changes presentation only, and later native MCP activation no longer needs a presentation reload. No package-removal, configuration, or credential migration happens automatically.

## Manually migrate server definitions

Review the old server definitions yourself and manually convert the desired entries into `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`. Pi reads project definitions only after project trust; a project server replaces a user-level server with the same name. Do not copy the entire old extension settings document: custom protocol, policy, retention, and timeout fields are not native Pi settings.

For example, a native stdio definition is:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "your-server-executable",
      "args": ["--your-argument"],
      "exposure": "codemode"
    }
  }
}
```

Native stdio uses `command`, `args`, optional `env`, and optional `cwd`. Native HTTP uses `url`, optional `headers`, and optional `oauth`; native `timeout` is in seconds. Keep secrets out of project files and review environment-variable references. Validate the converted configuration with `pi mcp list`, then use native `/mcp` for status, exposure, enablement, reconnect, and sign-in.

Migrate credentials by **reauthenticating through native `/mcp`**, for example `/mcp login <server>`. Pi stores native OAuth credentials in `~/.pi/agent/mcp-auth.json`, not the retired extension's macOS Keychain storage. The old Keychain refresh quarantine, locking, and revocation semantics do not carry over. Nothing in this migration silently copies, exports, or deletes old credentials or settings. Review any eventual cleanup separately; never treat process death or a fresh sign-in as proof of settlement of an old pending native operation.

## Native codemode defaults

Pi registers native `codemode` inactive until selected or activated by an MCP server with default `codemode` exposure. Leave normal native defaults in place: a server with `deferred` exposure activates `tool_search`; `direct` exposes its tools directly; `hidden` keeps them unreachable. `autoEnableCodemode: false` deliberately suppresses automatic activation. If you want native codemode available without MCP servers, add `"+codemode"` to `defaultTools` rather than forcing all tools active.

Native tools are named `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_]` replaced by `_`, so `local-tools` above becomes `mcp__local_tools__…`. Tools of `codemode` servers are not listed in the codemode description; Pi lists the servers in an `mcp_servers` system prompt section, and scripts discover their tools with `searchTools()` and `describeNamespace()`, then call `tools.<registered_name>(args)`. Reading a `tools` member that does not exist throws, so test for a tool with `"name" in tools` rather than `typeof`. Their native results include `content`, optional `structuredContent`, and `isError`; forward native images with `image(result.content[0])` when appropriate. Calls use Pi's tool pipeline and permission hooks.

The old `mcp` gateway, `code_mode` tool, `tools.mcp.request` API, custom `tools.session.backgroundTask` adapter, retained-result IDs, paging envelopes, and receipt/auth semantics are retired. Rewrite programs to native codemode APIs; do not expect old tool names, schemas, result retention, or execution bypasses to remain. Reusable local-extension protocols in other packages are not an automatic native adapter.

See Pi's MCP and SDK documentation for the native configuration and embedding contracts. Historical plans and Code Mode audits in this repository remain historical evidence, not active ownership documentation.
