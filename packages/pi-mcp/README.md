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

Create a document at `<agent-dir>/extensions/pi-mcp.json`, normally `~/.pi/agent/extensions/pi-mcp.json`, or `<project>/.pi/extensions/pi-mcp.json`. The project directory name follows Pi's exported config-directory constant. Existing files must have a `mcpServers` object; `version` and `servers` are rejected. A missing file is valid absence. The first settings or server write creates `{ "mcpServers": {} }` before applying the change.

```json
{
  "mcpServers": {
    "files": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/server-filesystem/dist/index.js",
        "/absolute/path/allowed-directory"
      ],
      "env": {
        "HOME": "${HOME}"
      },
      "denyTools": ["delete_file"]
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Client": "pi"
      },
      "auth": { "type": "env", "env": "EXAMPLE_MCP_TOKEN" }
    }
  }
}
```

Install the server yourself and replace the example paths. A server with `command` is stdio, and one with `url` is HTTP, so `type` is optional. Supplying both fields or a mismatched `type` is invalid. Stdio launches an executable with an argument array, never an implicit shell. The child inherits only `PATH`, with `/usr/bin:/bin:/usr/sbin:/sbin` as the fallback. Add `HOME`, `TMPDIR`, or credentials through the string-valued `env` map. HTTP `headers` is also a string map. HTTP auth defaults to `{ "type": "none" }`; `type: "env"` supplies a bearer token. Old `transport`, `environment`, and `{ "env": ... }`/`{ "value": ... }` binding forms are not accepted.

At connection time, `${NAME}` in stdio `env` and HTTP `headers` resolves from the captured configuration provider. `$$` produces a literal dollar sign, so `$${NAME}` remains the literal `${NAME}`. Expansion is single-pass. It does not use shell expansion or recurse into substituted values. Only `env` and `headers` values expand; `command`, `args`, `url`, and `cwd` stay literal. Missing variables and expanded values that contain invalid control characters or exceed the configured length are rejected. Values resolve only when needed for connection or authentication, not during status inspection.

Both global and project servers require a trusted Pi session to execute. An untrusted session can inspect local global-config status but cannot read, stat, or write project configuration, resolve credentials, authenticate, connect, or launch servers. Trust does not sandbox a server. A configured MCP executable is trusted local code with the user's OS privileges. Its cwd, tool allow list, and environment policy are not filesystem or network containment.

Settings resolve project over global over defaults, field by field. A project server entry replaces the matching global entry in full, including its endpoint, headers, and auth configuration. `{ "enabled": false }` suppresses an inherited server. An invalid override disables that server instead of falling back to the global definition. An unreadable trusted project document blocks execution rather than ignoring possible overrides.

A stdio server's default cwd is its owning project root or agent directory. Relative `cwd` values resolve against that same directory. `allowTools` and `denyTools` match exact remote tool names; deny wins. An absent allow list permits advertised tools, while `[]` permits none. Denied tools cannot be discovered or called. Resources and prompts follow enabled-server policy, without per-URI or per-prompt rules.

Changes require `/mcp-settings reload` or a settings command. There is no watcher, host-config discovery, automatic package installation, or cross-session metadata cache. Writes preserve unrelated JSON fields and reject invalid legacy root fields without rewriting them.

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
/mcp
/mcp browse [ID]
/mcp result ID
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

Bare `/mcp` opens the server dashboard in TUI. In RPC and noninteractive modes it still means status. Explicit `/mcp status` keeps its structured reply. Bare `/mcp-settings` means show. Settings output omits endpoints, commands, environment and header values, and credential identities. For example, `/mcp-settings set-settings project {"requestTimeoutMs":90000}` changes one setting. Removing a project server entry reveals the global entry again; use `{ "enabled": false }` to keep it disabled.

### Dashboard and cached metadata

The TUI dashboard shows server scope, transport, connection state, observed auth state, active/queued work, and permitted cached counts. Opening it does not connect, discover metadata, check credentials, or allocate retained results. Enter inspects a server; `a` opens its action menu. Actions show blocked reasons and recheck the displayed target after confirmation. Sign in and Connect are separate actions.

`/mcp browse [ID]` searches all permitted cached tools, resources, templates, and prompts in the selected scope. Use `[` and `]` to change family, `s` to filter servers, and `n`/`p` for pages. Discovery is an explicit server action and may connect. Browsing never invokes tools, reads resources, retrieves prompts, or follows links and schema references. Refresh state remains visible beside retained metadata; revoked content disappears. If an advertised listing method returns JSON-RPC `-32601` on its first page, only that catalog becomes unsupported. Working catalogs remain available, with warnings explaining the unavailable family. Auth, timeout, cleanup, malformed results, and later-page failures do not get this fallback. These views use Cosmic UI navigation, responsive list/detail layouts, and configured key hints. `?` shows navigation help. Browse and result views are TUI-only.

A keyed MCP footer contribution summarizes connected, active, queued, and needs-attention counts. Activity shows actual shared sign-in, connection, and metadata work, including work initiated through Code Mode. It does not create jobs for idle connections or every tool call. Failures retain bounded local explanations. Inspecting Activity opens MCP details, not authentication or replay.

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

Only an explicit user `/mcp auth ID` command or dashboard Sign in action can start login. Local login owns an IPv4 loopback listener, normally `http://127.0.0.1:<ephemeral-port>/callback`, and opens the browser. A configured redirect must be a supported `http://127.0.0.1` callback. `/mcp auth ID --manual` requires a configured fixed-port redirect and collects the full callback URL in a user-only dialog. It does not start a local listener. The provider must support that registered redirect; manual mode is not a promise of universal remote-terminal login.

TUI and supported RPC dialogs can run login. The TUI panel reports actual phases, elapsed time, and the current enforced deadline. Escape cancels that exact attempt and joins owned cleanup. Reopen browser reuses the same validated URL without registering again or extending its deadline. Repeated sign-in requests do not queue another login. Browser-open failure leaves an explicit recovery action.

RPC uses stock private dialogs, never custom overlays. Manual handoff shows the authorization URL in a private confirmation body, followed by callback input; prompt titles are fixed and nonsecret. Local RPC offers explicit reopen/cancel choices while awaiting approval. Print/JSON mode can check an existing grant but cannot prompt or start a listener. Ordinary gateway and Code Mode calls never open login UI. Authorization URLs, codes, callback URLs, and tokens do not enter tool replies, public progress, Activity, or footer data.

Auth status is observational. `unchecked` means credentials have not been checked in this activation; `required` means missing/rejected credentials or explicit logout; `ready` means the latest applicable check or complete login succeeded; `unavailable` means auth could not be checked; `none` means no managed authentication. Environment-auth readiness means a credential is available, not that a user signed in. Generic permission denial does not invalidate auth evidence. None of these states proves a live connection.

The browser callback page only acknowledges receipt. Pi reports login success after credential persistence and the outer auth fence settle. Cancellation does not log out or undo a native Keychain write. Unresolved mutations remain blocked, and saved credentials followed by failed finalization get a partial-completion explanation rather than success.

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

`tools.list` and `tools.search` return compact selection entries by default, with no full-results mode. Entries preserve exact `server` and `name`, an optional title capped at 128 Unicode code points, and the first nonempty description paragraph capped at 512 code points. Whitespace is normalized; `titleTruncated` and `descriptionTruncated` disclose omitted text. Titles prefer the top-level title, then `annotations.title`. Only advertised boolean `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` annotations are copied. Missing hints remain unknown, and no hint grants permission. Schemas, examples, icons, and arbitrary extension fields are omitted.

Use `tools.describe` for an unfamiliar tool's complete definition and instructions before constructing arguments. If its output is truncated, recover the retained pages rather than guessing a missing schema. Discovery retains full immutable definitions internally, and invocation still validates against the complete current schema.

Search examines full names, titles, and descriptions, including text omitted from summaries. Exact names rank first, then name-token matches, title matches, and description matches. Multiword searches handle camelCase and common separators; all words must match. Equal ranks sort by exact server/name identity. Cached browsing uses the same ranking and also searches resource/template identifiers. Only the selected page is projected into response objects.

Invocation needs exact `server` and `tool` fields, without aliases or fuzzy matching. Targeted discovery may connect lazily; unscoped list/search only inspect known snapshots and report undiscovered servers. Status never connects. Cursors belong to a frozen metadata revision and become invalid when it changes.

Code Mode exposes these data actions through `tools.mcp.request`, but excludes `connect`, `disconnect`, `refresh`, auth, configuration writes, and arbitrary protocol methods. It requires exactly one active provider in the same stable Pi session and rechecks that provider on each request. Merely importing the protocol does not load the extension.

Nested MCP calls bypass Pi `tool_call`/`tool_result` middleware, unrelated approval extensions, registered tool overrides, and previews. The shared MCP execution service still applies trust, server policy, validation, admission, and result limits. Only the outer `code_mode` call follows the ordinary Pi middleware path. See the [Code Mode README](../pi-code-mode/README.md#mcp-adapter).

## Results and safety

Replies carry `action`, `outcome`, `isError`, `data`, optional `resultId`, and `notices`. Execution certainty is separate from success:

- `not-sent`: the operation was not dispatched.
- `completed`: the operation completed, possibly with a server-reported error or a local validation failure.
- `unknown`: dispatch may have happened, but completion is unconfirmed.

Check both `outcome` and `isError`. Output validation or projection can fail after the remote operation completed. Cancellation, deadlines, and cleanup cannot roll back server side effects. Never replay an unknown or completed operation just to recover output. Use `result.read` when a result ID is present; follow its returned `next` offset rather than calculating byte offsets. Retrieval preserves the original operation's outcome and error status under `data.origin`.

HTTP and stdio JSON-RPC errors retain fixed diagnostic reasons such as `rpc-method-not-found` or `rpc-invalid-params`, rather than appearing as transport failures. Raw server messages and error data stay private. A completed failure does not prove that output was retained; error guidance does not offer retained-output recovery without a result ID.

The owned gateway has compact call/result cards under the existing code-preview shell. Expanded cards show recognized MCP text with its newlines and indentation, alongside sanitized raw JSON. One combined display budget covers both sections. String, collection, depth, node, line, and character cuts are disclosed separately from source truncation or operation failure. Expansion never changes the original JSON, images, error receipts, or execution certainty. Unknown completion, cleanup, truncation, and originating failures remain visible when collapsed. Ordinary cancellations use operation-neutral guidance, not sign-in instructions.

`/mcp result ID` opens an authorized local retained-output viewer. A complete JSON page containing recognized tool, resource, or prompt text defaults to readable text; `v` toggles sanitized raw JSON. Partial pages stay raw, even when a fragment happens to parse as JSON. The viewer keeps its existing 8,192-character read allowance and never assembles pages to enable readable mode. Raw view retains page-sized strings and collections rather than applying the card's smaller cuts.

Mode changes perform no reads or execution. Navigation follows original returned offsets, not sanitized text lengths, and preserves the originating outcome. The viewer keeps one authorized page and bounded previous offsets. Eviction or revocation withdraws both views; recovery never reruns the source operation. There is no new result-history store. Display sanitization is not a guarantee that arbitrary remote content contains no sensitive information.

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

The smoke verified cleanup of owned processes, temporary installation, browser, and profile. Owned HTTP/OAuth fixtures cover cases that do not need third-party accounts. This evidence does not certify every SDK-negotiated protocol, server, OAuth provider, or OS. The original MCP acceptance also passed the workspace and packed-install gates. The [implementation plan](../../docs/plans/pi-mcp.md#acceptance-record) records that evidence; the [UI upgrade record](../../docs/plans/pi-mcp-ui.md#implementation-record) tracks this change's checks and any baseline failures.

```sh
pnpm --filter pi-mcp test
pnpm --filter pi-mcp typecheck
pnpm --filter pi-mcp effect:diagnostics
pnpm --filter pi-code-mode test
pnpm mcp:smoke
pnpm validate
```

`mcp:smoke` installs pinned servers and downloads a browser into owned temporary storage. It needs network access and macOS, but no user account credentials. See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and cleanup boundaries.
