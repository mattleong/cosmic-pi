# MCP Previews

Always-on previews for Pi's native MCP tools and resources. Requires the public `createMcpExtension()` factory from Pi 0.99 or later; the workspace pins Pi 1.0.0.

## Install

```sh
pi install npm:pi-mcp-previews
```

Installation activates the adapter automatically; there is no toggle, environment opt-in, or startup setting. Old `nativeMcpPreviews` settings and `CODE_PREVIEW_NATIVE_MCP` values have no effect.

- `/mcp`: Pi's native server status, enablement, exposure, reconnect, and sign-in management.
- `/mcp-previews`, `status`, or `health`: adapter ownership and presentation fallback status.
- `/code-previews`: shared appearance settings, including preview/compact style, timing, and backgrounds. Install `pi-code-previews` as an extension too to expose that command; its public rendering library is a runtime dependency here. Reload after changing appearance.

## Native behavior stays native

This package composes Pi's public MCP extension with **no options**. Pi still owns trusted user/project `mcp.json`, disabled servers, exposure defaults, dynamic server registrations, connections, OAuth and its credential store, permissions, execution, cancellation, and saved output. There are no SDK clients, custom credentials, transports, capabilities, or server configuration in this package.

Only freshly created native definitions receive render callbacks and the cooperative Code Previews shell. Registered names, schemas, annotations, namespaces, exposure, execute functions, result data, recovery text, and native images remain unchanged. Non-error returns are neutral delivery outcomes, not claims of domain success. Settings, scheduler, or styling failures retain native MCP, forwarding affected definitions unstyled.

## Entrypoint replacement and attribution

This is intentional native manager composition, not a hook around another extension's tools. During extension loading the composed factory registers `/mcp` under this package, so Pi omits its replaceable builtin. Native commands and tools therefore show this package as their extension source even though their management and execution come from Pi. The unique `/mcp-previews` source anchor must match the sole `/mcp` before startup; ambiguous or foreign commands fail closed. A late conflict cannot prevent cleanup or admitted native server-removal processing.

Factory registrations are buffered before commit. A rejected factory leaves no takeover before commit; public host registration can mutate then throw during commit, so there is **no rollback guarantee**. Failed composition leaves its gates closed and health reports failure.

Uninstall and reload to restore builtin native MCP presentation (provided the builtin is enabled). No server or credential migration is needed:

```sh
pi remove npm:pi-mcp-previews
```

SDK applications may use this package's default extension factory with a public `DefaultResourceLoader`; other native extensions such as codemode/tool search remain independent.
