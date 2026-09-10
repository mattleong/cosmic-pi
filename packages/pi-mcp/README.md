# pi-mcp

A private, local Pi extension with one `mcp` gateway for configured MCP tools, resources, resource templates, and prompts. Code Mode uses the same execution service through the fixed `tools.mcp.request` adapter. MCP works without Code Mode.

The implementation targets macOS. It uses the official MCP client/core SDK 2.0.0 with legacy negotiation. Modern negotiation, legacy HTTP+SSE fallback, MCP Apps, sampling, elicitation, roots, and tasks are outside this release.

## Setup

From this workspace:

```sh
pnpm install
pi install "$PWD/packages/pi-mcp"
```

For a single session, use `pi -e ./packages/pi-mcp`. Disable or remove another extension that registers `mcp` before switching. This package reports a foreign `mcp` registration and leaves it untouched; it does not uninstall or replace another extension.

Pi/Jiti loads the shipped TypeScript source and fixed validator helper. No build or generated `dist/` is required. There is no importer for another MCP extension's configuration.

## Configuration and trust

Create a version 1 document at `<agent-dir>/extensions/pi-mcp.json`, normally `~/.pi/agent/extensions/pi-mcp.json`, or `<project>/.pi/extensions/pi-mcp.json`. The project directory name follows Pi's exported config-directory constant.

```json
{
  "version": 1,
  "servers": {
    "files": {
      "transport": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/server-filesystem/dist/index.js",
        "/absolute/path/allowed-directory"
      ],
      "environment": {
        "HOME": { "env": "HOME" }
      },
      "denyTools": ["delete_file"]
    },
    "remote": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Client": { "value": "pi" }
      },
      "auth": { "type": "env", "env": "EXAMPLE_MCP_TOKEN" }
    }
  }
}
```

Install the server yourself and replace the example paths. Stdio launches an executable with an argument array, never an implicit shell. The child inherits only `PATH`, with `/usr/bin:/bin:/usr/sbin:/sbin` as the fallback. Add `HOME`, `TMPDIR`, or credentials through explicit `environment` bindings if needed. Bindings accept either `{ "env": "NAME" }` or `{ "value": "literal" }`; no command substitution runs. HTTP `headers` use the same binding form. HTTP auth defaults to `{ "type": "none" }`; `type: "env"` supplies a bearer token. Environment values resolve only when needed for connection or authentication, not during status inspection.

Both global and project servers require a trusted Pi session to execute. An untrusted session can inspect local global-config status but cannot read, stat, or write project configuration, resolve credentials, authenticate, connect, or launch servers. Trust does not sandbox a server. A configured MCP executable is trusted local code with the user's OS privileges. Its cwd, tool allow list, and environment policy are not filesystem or network containment.

Settings resolve project over global over defaults, field by field. A project server entry replaces the matching global entry in full, including its endpoint, headers, and auth configuration. `{ "enabled": false }` suppresses an inherited server. An invalid override disables that server instead of falling back to the global definition. An unreadable trusted project document blocks execution rather than ignoring possible overrides.

A stdio server's default cwd is its owning project root or agent directory. Relative `cwd` values resolve against that same directory. `allowTools` and `denyTools` match exact remote tool names; deny wins. An absent allow list permits advertised tools, while `[]` permits none. Denied tools cannot be discovered or called. Resources and prompts follow enabled-server policy, without per-URI or per-prompt rules.

Changes require `/mcp-settings reload` or a settings command. There is no watcher, host-config discovery, automatic package installation, or cross-session metadata cache. Writes preserve unrelated JSON fields and reject unknown document versions.

| Setting            | Default  | Bounds        |
| ------------------ | -------- | ------------- |
| `enabled`          | `true`   | boolean       |
| `connectTimeoutMs` | `15000`  | 1 to 600000   |
| `requestTimeoutMs` | `60000`  | 1 to 3600000  |
| `idleTimeoutMs`    | `600000` | 1 to 86400000 |
| `maxConcurrent`    | `8`      | 1 to 128      |
| `maxPerServer`     | `4`      | 1 to 128      |
| `maxQueued`        | `64`     | 0 to 4096     |

## User commands

```text
/mcp status
/mcp connect ID
/mcp disconnect ID
/mcp refresh ID
/mcp auth ID
/mcp auth ID --manual
/mcp logout ID
/mcp-settings show
/mcp-settings reload
/mcp-settings set-server global|project ID JSON
/mcp-settings remove-server global|project ID
/mcp-settings set-settings global|project JSON
```

Bare `/mcp` means status. Bare `/mcp-settings` means show. Settings output omits endpoints, commands, bindings, and credential identities. For example, `/mcp-settings set-settings project {"requestTimeoutMs":90000}` changes one setting. Removing a project server entry reveals the global entry again; use `{ "enabled": false }` to keep it disabled.

## OAuth

OAuth is HTTP-only and supports public clients with PKCE S256 and token-endpoint auth method `none`. Set one of these `auth` objects on the HTTP server:

```json
{ "type": "oauth", "registration": "pre-registered", "clientId": "YOUR_PUBLIC_CLIENT_ID" }
```

```json
{ "type": "oauth", "registration": "dynamic" }
```

```json
{
  "type": "oauth",
  "registration": "metadata",
  "clientMetadataUrl": "https://client.example.com/oauth.json"
}
```

Dynamic registration and Client ID Metadata Documents require the authorization server to advertise support. This extension does not host a client metadata document or support confidential-client secrets. Optional OAuth fields are `issuer`, `resource`, `scopes`, and `redirectUri`. If `registration` is omitted, `clientId` selects pre-registration, `clientMetadataUrl` selects metadata registration, and neither selects dynamic registration.

Protected-resource metadata is required by default. For a legacy server that publishes authorization-server metadata but no protected-resource metadata, explicitly pin its issuer and opt into compatibility:

```json
{
  "type": "oauth",
  "registration": "dynamic",
  "issuer": "https://mcp.atlassian.com",
  "allowMissingResourceMetadata": true
}
```

This fallback applies only when every protected-resource discovery response is `404` or `410`. It uses the configured issuer and `resource`, or the server URL when `resource` is absent. It never replaces valid metadata, bypasses a binding mismatch, or recovers from malformed responses, other HTTP errors, network failures, denied redirects, or timeouts. An issuer pin alone does not enable compatibility. Stored grants record configured metadata provenance; removing the opt-in or changing the issuer/resource prevents their reuse. Discovery failures expose fixed diagnostic reasons, not server response text.

Only an explicit user `/mcp auth ID` command can start login. Local login owns an IPv4 loopback listener, normally `http://127.0.0.1:<ephemeral-port>/callback`, and opens the browser. A configured redirect must be a supported `http://127.0.0.1` callback. `/mcp auth ID --manual` requires a configured fixed-port redirect and collects the full callback URL in a user-only dialog. It does not start a local listener. The provider must support that registered redirect; manual mode is not a promise of universal remote-terminal login.

TUI and supported RPC dialogs can run login. Print/JSON mode can check an existing grant but cannot prompt or start a listener. Ordinary gateway and Code Mode calls never open login UI. Codes, callback URLs, and tokens are not tool inputs or model results.

The SDK handles discovery, registration, PKCE, exchange, and refresh. Application policy checks issuer/resource binding, callback state and issuer, URL schemes, redirects, and resolved addresses. OAuth HTTP connections use the address set already approved by policy, with no second DNS lookup. Remote endpoints require HTTPS; local HTTP is limited to explicitly configured loopback origins. Discovered private addresses require an explicitly trusted origin. Tokens are not forwarded across redirects.

Credentials use macOS Keychain through `@napi-rs/keyring`. There is no plaintext or session-only OAuth fallback. An unavailable store blocks OAuth login and refresh, but not no-auth or environment-auth servers. Credentials are bound to their owning configuration and target, not just the server name. Refresh happens before dispatch when needed; a rejected dispatched call is not replayed. Scope step-up needs another user auth command.

OAuth logout revokes local auth and connection authority, removes retained results, and deletes local credentials. It does not revoke tokens at the provider. Environment and no-auth servers reject logout as unsupported. Failed Keychain deletion is reported as a failure, not a successful logout. Native Keychain create/read/replace/delete and absence checks passed in a disposable namespace; see the [acceptance record](../../docs/plans/pi-mcp.md#acceptance-record).

## Gateway and Code Mode

The gateway accepts an explicit `action`; omitting it means `status`. Each action rejects unrelated fields.

| Action                                                  | Inputs besides `action`                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `status`                                                | none                                                   |
| `connect`, `disconnect`, `refresh`                      | `server`                                               |
| `tools.list`                                            | optional `server`, `cursor`, `limit`                   |
| `tools.search`                                          | `query`; optional `server`, `cursor`, `limit`          |
| `tools.describe`                                        | `server`, `tool`                                       |
| `tools.call`                                            | `server`, `tool`; optional object `arguments`          |
| `resources.list`, `resources.templates`, `prompts.list` | `server`; optional `cursor`, `limit`                   |
| `resources.read`                                        | `server`, `uri`                                        |
| `prompts.get`                                           | `server`, `prompt`; optional string-valued `arguments` |
| `result.read`                                           | `id`; optional `offset`, `limit`, `attachment`         |

Discovery returns original remote names. Invocation needs exact `server` and `tool` fields, without aliases or fuzzy matching. Targeted discovery may connect lazily; unscoped list/search only inspect known snapshots and report undiscovered servers. Status never connects. Cursors belong to a frozen metadata revision and become invalid when it changes.

Code Mode exposes these data actions through `tools.mcp.request`, but excludes `connect`, `disconnect`, `refresh`, auth, configuration writes, and arbitrary protocol methods. It requires exactly one active provider in the same stable Pi session and rechecks that provider on each request. Merely importing the protocol does not load the extension.

Nested MCP calls bypass Pi `tool_call`/`tool_result` middleware, unrelated approval extensions, registered tool overrides, and previews. The shared MCP execution service still applies trust, server policy, validation, admission, and result limits. Only the outer `code_mode` call follows the ordinary Pi middleware path. See the [Code Mode README](../pi-code-mode/README.md#mcp-adapter).

## Results and safety

Replies carry `action`, `outcome`, `isError`, `data`, optional `resultId`, and `notices`. Execution certainty is separate from success:

- `not-sent`: the operation was not dispatched.
- `completed`: the server result was accepted, including a tool-reported failure.
- `unknown`: dispatch may have happened, but completion is unconfirmed.

Check both `outcome` and `isError`. Output validation or projection can fail after the remote operation completed. Cancellation, deadlines, and cleanup cannot roll back server side effects. Never replay an unknown or completed operation just to recover output. Use `result.read` when a result ID is present; follow its returned `next` offset rather than calculating byte offsets. Retrieval preserves the original operation's outcome and error status under `data.origin`.

Accepted results are retained before inline projection. Disconnect preserves completed results. Disable, reconfigure, trust loss, logout, eviction, and session replacement revoke them. A retention failure explicitly says the output is not recoverable. Oversized wire responses may never reach retention.

| Limit                               | Value                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Config document / one server entry  | 1 MiB / 64 KiB, at most 256 servers                                    |
| Serialized invocation input         | 1 MiB, with structural limits                                          |
| Transport message / accepted result | 8 MiB                                                                  |
| Inline text and details             | 50 KiB and 2,000 lines                                                 |
| Discovery page                      | 20 entries by default, at most 100                                     |
| Remote discovery traversal          | 64 pages, 1,000 entries per family, 4 MiB metadata                     |
| Retention                           | 32 results and 64 MiB per session, oldest settled result evicted first |
| Native images per reply             | 8, under the separate 8 MiB encoded-data allowance                     |
| Declared image dimensions           | At most 40 million pixels                                              |

Top-level results can include PNG, JPEG, GIF, and WebP images. Checks cover bounded base64, MIME, headers/container structure, and declared dimensions, not full image decompression or validation of every frame. Audio and other binary content become descriptors or omission notices. `result.read` can select a stored supported image by attachment index. Code Mode receives JSON descriptors for recognized binary envelopes, not their base64 payloads or native images. Ordinary text remains text; the client does not reinterpret arbitrary encoded strings. Code Mode's remaining output budget can lower the projection limit.

Server instructions, descriptions, prompt messages, and resource content are untrusted data. They are not added to the system prompt or treated as commands. Prompt roles remain data, not new user messages or slash commands. Resource reads route only through the selected server. The client never independently fetches returned HTTP links, opens `file://` paths, or follows resource links automatically. These rules reduce accidental authority transfer; they do not make remote content safe from prompt injection.

## Compatibility and checks

The macOS real-server smoke passed through `McpExecution` with protocol `2025-11-25`:

- `@modelcontextprotocol/server-filesystem@2026.8.31`: 14 tools, read/write, input/output validation, and bounded recovery of an 80 KB retained result.
- `@playwright/mcp@0.0.80`: 24 tools, isolated browser navigation to an owned local page, snapshot, evaluation, and close. Its Playwright manifest was `1.63.0-alpha-2026-08-31`, with Chromium `153.0.8010.12`, revision `1243`.

The smoke verified cleanup of owned processes, temporary installation, browser, and profile. Owned HTTP/OAuth fixtures cover cases that do not need third-party accounts. This evidence does not certify every SDK-negotiated protocol, server, OAuth provider, or OS. The full workspace and packed-install gates also passed. The [plan](../../docs/plans/pi-mcp.md#acceptance-record) records the acceptance checks.

```sh
pnpm --filter pi-mcp test
pnpm --filter pi-mcp typecheck
pnpm --filter pi-mcp effect:diagnostics
pnpm --filter pi-code-mode test
pnpm mcp:smoke
pnpm validate
```

`mcp:smoke` installs pinned servers and downloads a browser into owned temporary storage. It needs network access and macOS, but no user account credentials. See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and cleanup boundaries.
