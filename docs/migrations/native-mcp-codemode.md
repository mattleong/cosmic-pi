# Migrate to native Pi MCP and codemode

Cosmic Pi `0.2.0` retires `pi-mcp` and `pi-code-mode`. Pi now owns MCP configuration, authentication, connections, execution, tool exposure, and native `codemode`. There is intentionally no compatibility layer.

## Replace the extensions

1. Uninstall the old extensions from every scope where they were installed. Use `pi remove npm:pi-code-mode` for the published extension, or `pi remove /absolute/path/to/packages/pi-code-mode` and `pi remove /absolute/path/to/packages/pi-mcp` for local installs. Add `-l` for project-local installations. Remove any remaining explicit old extension paths from Pi settings.
2. Install the public presentation adapter: `pi install npm:pi-mcp-previews`. For a workspace checkout with dependencies installed, use `pi install "$PWD/packages/pi-mcp-previews"` instead. Use `-l` if project-local installation is intended.
3. Keep or install `pi-code-previews` for the generic tool shell, built-in previews, and eligible native `codemode` styling. It no longer manages standalone MCP previews.
4. Remove obsolete `-builtin:mcp` exclusions that previously disabled native MCP for the custom gateway. Remove custom `-builtin:codemode` exclusions if they were only there for the retired extension. Preserve deliberate user restrictions; do not enable every tool or replace your allowlist indiscriminately.
5. Run `/reload` or restart Pi after changing installation or configuration.

`pi-mcp-previews` is always on while installed, with no enable/disable setting. The former Code Previews `nativeMcpPreviews` preference is obsolete and is not a migration or disable control; remove it manually if desired. Remove it and reload to restore the native MCP renderer. Its composed public `createMcpExtension()` factory supplies native `/mcp`; Pi omits the replaceable builtin manager, so there is still only one manager. Native behavior and configuration stay with Pi.

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
