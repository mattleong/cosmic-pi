# pi-mcp

A private, local Pi extension with one `mcp` gateway for configured MCP tools, resources, resource templates, and prompts. Code Mode uses the same execution service through the fixed `tools.mcp.request` adapter. MCP works without Code Mode.

The implementation targets macOS. It supports MCP `2026-07-28` and the official client/core SDK 2.0.0's legacy revisions over stdio and Streamable HTTP. Historical HTTP+SSE transport is unsupported; SSE within Streamable HTTP is supported. Apps and tasks are deferred, and sampling and roots are not added. See the [capability matrix](./CAPABILITIES.md) for implemented behavior and restrictions, and [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and lifecycle.

## Setup

From this workspace:

```sh
pnpm install
pi install "$PWD/packages/pi-mcp"
```

Disable Pi's built-in MCP extension in `pi config` under **Built-in extensions**, or add `"-builtin:mcp"` to the `extensions` array in `~/.pi/agent/settings.json`. Keep this package enabled; both implementations register `/mcp` and should not be loaded together.

For a single session, use `pi -e ./packages/pi-mcp`. Disable or remove any other extension that registers `mcp` first; this package reports a foreign `mcp` registration and leaves it untouched. Pi/Jiti loads the shipped TypeScript source directly, with no build step. There is no importer for another MCP extension's configuration.

## Tool display

MCP honors pi-code-previews' `toolCallCollapsedStyle: "compact"` setting. Pending calls show their action and target; completed replies show semantic counts and one line per warning or error. Expansion adds each issue's recovery detail above the arguments and the labeled readable and raw result. Unknown, malformed, and incomplete historical results keep the detailed renderer rather than hide execution uncertainty. The default `"preview"` style, native images, and machine replies are unchanged.

## Configuration and trust

Configuration loads from these files, in increasing precedence:

1. `<agent-dir>/extensions/pi-mcp.json`, normally `~/.pi/agent/extensions/pi-mcp.json`.
2. `<project>/.mcp.json`.
3. `<project>/.pi/extensions/pi-mcp.json`.

The project is the session's working directory; parent directories are not searched. Both project files require project trust. A file needs a `mcpServers` object; a missing file is valid absence, an existing `{}` is invalid until a settings command initializes it, and reads never repair files.

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

A server with `command` is stdio and one with `url` is HTTP, so `type` is optional; supplying both, or a mismatched `type`, is invalid. Stdio launches an executable with an argument array, never a shell. The child inherits only `PATH` (falling back to `/usr/bin:/bin:/usr/sbin:/sbin`); add `HOME`, `TMPDIR`, or credentials through the string-valued `env` map. HTTP `headers` is also a string map, and cannot set MCP protocol headers (`MCP-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, `Mcp-Param-*`), which the client owns.

Omitting HTTP `auth` with no custom headers enables implicit OAuth: the server connects anonymously until an authentication challenge or an explicit credential check. With custom headers, omitted `auth` means no managed authentication and preserves those headers, including Authorization. `"auth": false` or `{ "type": "none" }` disables managed authentication; `"auth": true` is rejected. `{ "type": "env", "env": "NAME" }` supplies a managed bearer token. Old `transport`, `environment`, and binding-object forms are not accepted.

At connection time, `${NAME}` in stdio `env` and HTTP `headers` resolves from the environment. `$$` produces a literal dollar sign, and expansion is single-pass with no shell or recursion. `command`, `args`, `url`, and `cwd` stay literal. Missing variables and values with control characters or excessive length are rejected. A stdio server's default `cwd` is its owning project root or agent directory, and relative values resolve against it.

`allowTools` and `denyTools` match exact remote tool names, and deny wins. An absent allow list permits advertised tools, while `[]` permits none. Denied tools cannot be discovered or called. Resources and prompts follow enabled-server policy. Trusted sessions, enabled servers, and these rules are the whole authorization model: permitted tools run without another confirmation, and server annotations never grant permission.

Both global and project servers require a trusted Pi session to execute. An untrusted session can inspect global status but cannot touch project configuration, resolve credentials, authenticate, connect, or launch servers. Trust is not a sandbox: a configured executable is trusted local code with your OS privileges.

Settings merge field by field in precedence order, starting from defaults. A higher-priority server entry replaces the matching lower one in full; `{ "enabled": false }` suppresses an inherited server. An invalid override disables that server instead of falling back, and an unreadable trusted project document blocks execution. Changes take effect after `/mcp settings reload` or a settings command; there is no file watcher. Project settings commands write only `.pi/extensions/pi-mcp.json`, never `.mcp.json`.

| Setting            | Default  | Bounds        |
| ------------------ | -------- | ------------- |
| `enabled`          | `true`   | boolean       |
| `connectTimeoutMs` | `15000`  | 1 to 600000   |
| `requestTimeoutMs` | `60000`  | 1 to 3600000  |
| `idleTimeoutMs`    | `600000` | 1 to 86400000 |
| `maxConcurrent`    | `8`      | 1 to 128      |
| `maxPerServer`     | `4`      | 1 to 128      |
| `maxQueued`        | `64`     | 0 to 4096     |

### Protocol negotiation

Both transports accept an optional `"protocol": "auto"` (the default) or `"protocol": "legacy"`. Automatic negotiation probes for `2026-07-28` first, and the SDK classifies the reply. Authorization failures, server errors, network failures, and HTTP timeouts stay errors. Method-not-found, other client errors (such as a stateful 2025 server's uncorrelated `400`, as Atlassian's `/v2/mcp` returns), and unusable replies fall back to legacy initialization. A version error listing only newer modern revisions fails as unsupported. Set `"protocol": "legacy"` for a known legacy server to skip the probe.

Stdio probes on a disposable child and launches the real one only after confirming the probe's cleanup, so a session's first connection can run the executable twice. The probe waits up to half the connection budget, so a cold `npx` or `uvx` start is not mistaken for silence; a probe that stays silent that long, or exits before answering, selects legacy. Later connections to the same definition in the session reuse only the negotiated era: legacy skips the probe, and modern pins its revision and negotiates on the application child, failing rather than downgrading if the server changed. A failed connection forgets that verdict.

Status reports each server's negotiated `protocolVersion` and list-change `observation` health. Modern list-change subscriptions belong to the connection; a server may honor only some families, and losing observation withdraws stale metadata. A session-bearing legacy 404 invalidates the connection without replaying that call. Any HTTP answer to the closing DELETE settles it, so a server that rejects DELETE cannot block reconnecting.

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
/mcp settings
/mcp settings status
/mcp settings reload
/mcp settings set-server global|project ID JSON
/mcp settings remove-server global|project ID
/mcp settings set-settings global|project JSON
```

Typing `/mcp ` autocompletes subcommands and server IDs. Bare `/mcp` and `/mcp status` open the server dashboard in TUI and return the structured status reply elsewhere. `/mcp settings` lists the settings commands, and `/mcp settings status` shows the configuration without endpoints, commands, environment or header values, or credential identities. For example, `/mcp settings set-settings project {"requestTimeoutMs":90000}` changes one setting. Removing a project override reveals the `.mcp.json` or global entry beneath it; use `{ "enabled": false }` to keep it disabled.

### Dashboard and cached metadata

The TUI dashboard lists each server's scope and status, with details for auth, metadata, and activity. Configuration errors show a bounded field-level explanation and the expected format, never configured values. Opening it does not connect, discover metadata, check credentials, or allocate results. Enter inspects a server and `a` opens its action menu, which highlights Sign in, Discover, or Browse as appropriate; nothing runs until you choose. Logging out, and disconnecting a server with work in progress, confirm first. `?` explains each action.

`/mcp browse [ID]` searches permitted cached tools, resources, templates, and prompts. `[` and `]` change family, `s` filters servers, and `n`/`p` page. Browsing never invokes tools, reads resources, retrieves prompts, or follows links. If a listing method returns `-32601` on its first page, only that catalog is marked unsupported; other failures are not treated that way.

A footer contribution summarizes connected, active, queued, and needs-attention counts. Activity shows shared sign-in, connection, and metadata work, including work started through Code Mode.

## OAuth

OAuth is HTTP-only and supports public clients with PKCE S256 and token-endpoint auth method `none`. Explicit `{ "type": "oauth" }` requires credentials before connecting. Registration options:

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

If `registration` is omitted, `clientId` selects pre-registration, `clientMetadataUrl` selects a Client ID Metadata Document, and neither selects dynamic registration. A metadata document selected only by `clientMetadataUrl` falls back to dynamic registration when the authorization server does not support such documents; an explicit `"registration": "metadata"` never switches. This extension does not host a metadata document or support secret-based client authentication; a registration that declares `none` may carry an unused secret, which is discarded. Other optional fields are `issuer`, `resource`, `scopes`, `redirectUri`, and `allowMissingResourceMetadata`.

Dynamic registration saves a sanitized checkpoint before opening the browser, and later sign-ins reuse a compatible one. If the token endpoint answers `invalid_client`, or a sign-in with a reused client times out or is cancelled (a server that forgot the client shows its error in the browser and never redirects back), the checkpoint is dropped and the next `/mcp auth` registers fresh.

**Scopes.** Omitted `scopes` lets a validated challenge or the protected-resource metadata propose them, never the authorization server's general catalog; `"scopes": []` requests none. An `insufficient_scope` step-up requests the previous grant's scopes plus the challenged ones and asks approval only for the new ones. `offline_access` is added when advertised and refresh is permitted. Inferred or added scopes need your private confirmation. The server may grant different scopes than requested, as RFC 6749 allows.

**Discovery.** A rejected POST can retain its `WWW-Authenticate` challenge privately for that operation's later sign-in. A challenge that is ambiguous or malformed is ignored, and discovery continues from the resource's own well-known metadata; a well-formed hint naming an unsafe destination fails. Protected-resource metadata may name the endpoint or a parent path on the same origin, and the grant binds to that identifier; a configured `resource` must match exactly. When protected-resource metadata returns only `404` or `410`, sign-in discovers the authorization server at the configured `issuer` or the endpoint's origin; set `allowMissingResourceMetadata: false` to require the metadata. Authorization-server metadata candidates move on after a client error or `502`. Configured issuers match exactly; an inferred bare-host issuer tolerates a trailing slash. Remote endpoints require HTTPS, private addresses need an explicitly trusted origin, and tokens never follow redirects.

**Signing in.** Only `/mcp auth ID` or the dashboard's Sign in action starts sign-in; tool calls never open login UI. Local sign-in listens on `http://127.0.0.1:<port>/callback` and opens the browser. `/mcp auth ID --manual` needs a configured fixed-port redirect and asks for the full callback URL in a private dialog. The TUI panel shows progress and the deadline; Escape cancels that attempt, and Reopen browser reuses the same URL. RPC uses stock private dialogs. Print/JSON mode can check an existing grant but cannot prompt. Denying access in the browser cancels the sign-in. Authorization URLs, codes, and tokens never enter tool replies, progress, Activity, or the footer.

Auth status is observational: `unchecked` (not checked in this activation), `required` (missing or rejected credentials, or logged out), `ready` (the latest check or sign-in succeeded), `unavailable` (could not be checked), or `none` (no managed authentication). None of these proves a live connection.

**Tokens.** Refresh happens before dispatch when a token is near expiry. When a server rejects an unexpired token and a refresh token exists, the next request refreshes once instead of requiring sign-in; a second rejection within a minute of that requires sign-in. The rejected request is never replayed. Before a refresh token is spent, a quarantine marker is saved, and only a validated replacement clears it; a refresh that failed after sending needs explicit sign-in, even after a restart. A refresh that fails before sending, such as a DNS failure after sleep, keeps the token usable. Managed tokens never reach remote plaintext HTTP.

**Storage.** Credentials live in the macOS Keychain through `@napi-rs/keyring`, with no plaintext fallback. They are keyed to the server's source file, id, URL, and `auth` block, so editing `protocol`, headers, or tool rules keeps the sign-in, while changing the URL or `auth` requires `/mcp auth ID` again. Do not copy Keychain records between identities. A Keychain write that is refused or outlives its wait stops blocking once it settles. Logout revokes local authority, removes retained results, and deletes the grant and registration checkpoint, but does not revoke tokens at the provider.

Credential transactions serialize across Pi processes for the same Keychain account through a lock namespace beneath your OS home (`.cosmic-pi-locks-v1`). Lock admission has a 15-second default that never expires admitted work. A dead owner with a pending native Keychain operation stays blocked, because process death does not prove the operation settled.

### Credential coordination recovery

If coordination reports that recovery is required:

1. Stop all participating Pi processes and reclaimers, including other sessions and agent directories for the same OS user. Do not run maintenance alongside a process that can acquire these locks.
2. Inspect the reported namespace and artifacts individually. Do not delete the lock root or bulk-remove active, malformed, or native-pending evidence.
3. For native-pending evidence, independently establish that the original Keychain operation settled before changing any coordination record. PID death, elapsed time, and a fresh login are not proof. Without proof, leave the evidence and seek maintainer help.
4. Preserve refresh quarantine. Removing a lock artifact does not make an old refresh token safe. Once native uncertainty is resolved, use `/mcp auth ID` for a quarantined grant.

There is no reset command or automatic unsafe reset. Do not paste tokens, Keychain values, or authorization and callback URLs into a model conversation.

## Gateway and Code Mode

The gateway accepts an explicit `action` (default `status`), and each action rejects unrelated fields. Rejected requests return fixed, action-specific repair guidance without echoing supplied values. List and search `limit` is 1 to 100; `result.read` returns up to 50,000 UTF-16 code units per page.

| Action                                                  | Inputs besides `action`                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `status`                                                | none                                                               |
| `server.instructions`                                   | `server`                                                           |
| `connect`, `disconnect`, `refresh`                      | `server`                                                           |
| `tools.list`                                            | optional `server`, `cursor`, `limit`                               |
| `tools.search`                                          | `query`; optional `server`, `cursor`, `limit`                      |
| `tools.describe`                                        | `server`, `tool`                                                   |
| `tools.call`                                            | `server`, `tool`; optional object `arguments`, `logLevel`          |
| `resources.list`, `resources.templates`, `prompts.list` | `server`; optional `cursor`, `limit`                               |
| `resources.read`                                        | `server`, `uri`; optional `logLevel`                               |
| `prompts.get`                                           | `server`, `prompt`; optional string-valued `arguments`, `logLevel` |
| `completion.complete`                                   | `server`, `ref`, `argument`; optional `context`, `logLevel`        |
| `events.read`                                           | `server`; optional string `cursor`, `limit`                        |
| `resources.subscribe`, `resources.unsubscribe`          | `server`, `uri`                                                    |
| `resources.subscriptions`                               | `server`                                                           |
| `result.read`                                           | `id`; optional `offset`, `limit`, `attachment`                     |

**Discovery.** `tools.list` and `tools.search` return compact entries: exact `server` and `name`, a title capped at 128 code points, the first description paragraph capped at 512, and advertised boolean hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Use `tools.describe` for a tool's complete definition before constructing arguments. Search ranks exact names, then name tokens, titles, and descriptions; all words must match. Unscoped list and search only read cached metadata and report undiscovered servers in `data.result.undiscovered`; pass one as `server` to discover it. Cursors belong to one metadata revision. A zero-match search suggests `tools.list`, `tools.describe`, or `server.instructions` before concluding an operation is unsupported.

Metadata freshness follows each page's `ttlMs` and `cacheScope`: missing or nonpositive TTL is immediately stale, and a TTL over a day is clamped to a day. TTL governs listing; calls reuse the current metadata until a list-change notification, failed refresh, reconnection, or configuration or auth change replaces it, so a server without TTL hints is listed once per connection. Passive views mark stale metadata rather than connecting. A failed refresh can leave earlier metadata visible to browsing with a warning.

**Calls.** Invocation needs exact `server` and `tool` names. Arguments are validated against the tool's input schema. If that schema uses features the local validator cannot check (for example OpenAPI `nullable`), the call is sent unchecked, the server still validates, and the reply says so. Tools that require 2025-11-25 task execution are refused. For modern HTTP, `x-mcp-header` annotations mirror string, integer, number, or boolean arguments into `Mcp-Param-*` headers (at most 64 headers and 16 KiB); invalid annotations exclude the tool. If the server rejects a call with header mismatch `-32020`, which the specification requires before the tool runs, the metadata is refreshed and the call retried once. That is the only automatic retry of a tool call.

`completion.complete` completes an argument for an advertised prompt or resource template, returning at most 100 values. `ref` is `{ "type": "ref/prompt", "name": "review" }` or `{ "type": "ref/resource", "uri": "files:///{path}" }`:

```json
{
  "action": "completion.complete",
  "server": "files",
  "ref": { "type": "ref/prompt", "name": "review" },
  "argument": { "name": "language", "value": "ty" },
  "context": { "arguments": { "style": "brief" } }
}
```

**Observations.** `events.read` reads local progress, log, and resource-update events without connecting. Follow its decimal-string `next` cursor; pages default to 32 events (1 to 100). The session ring holds at most 128 events and 128 KiB, and `truncated` reports evicted history. Events are best-effort evidence, not an audit log. `logLevel` opts into deprecated MCP request logging (`debug` through `emergency`); only modern HTTP servers that advertise logging support it, and elsewhere the request runs without it and says so. Progress works on both transports and never establishes completion.

**Subscriptions.** `resources.subscribe` subscribes to one URI on a server that advertises resource subscriptions, `resources.unsubscribe` closes it, and `resources.subscriptions` lists active ones locally. Leases are capped at 16 per connection and 32 per session, and updates arrive through `events.read` without triggering reads. Disconnect, authority loss, or stream closure ends a lease; there is no automatic re-listening.

**Instructions.** `server.instructions` returns the guidance captured during initialization, for example `{ "server": "files", "truncated": false, "instructions": "..." }`. It may connect but sends no application request. Capture keeps a 64 KiB prefix; missing instructions are `null`. Instructions remain untrusted data and are never added to the system prompt.

**Code Mode.** `tools.mcp.request` exposes the data actions but not `connect`, `disconnect`, `refresh`, authentication, configuration writes, or arbitrary protocol methods. It requires exactly one active provider in the same Pi session. Nested calls bypass Pi's `tool_call`/`tool_result` hooks and other extensions' checks; the shared execution service still applies trust, server policy, validation, admission, and result limits. See the [Code Mode README](../pi-code-mode/README.md#mcp-adapter).

## Private modern user input

Modern `tools.call`, `resources.read`, and `prompts.get` can ask for user input mid-call. They do so only through a current same-session `pi-ask-user` TUI/RPC form provider; headless and legacy sessions never advertise it, and legacy server-driven elicitation is unsupported. Forms support flat schemas of up to 16 string, number, integer, boolean, and string-enum fields. An operation allows at most 8 rounds and 16 requests, and answers stay private to the operation. URL requests show the full URL and host for consent and open the macOS browser only after you continue. Declining one request cancels the rest of that batch; a later round that asks nothing new still completes. Cancellation, provider loss, and round limits never authorize replay.

## Results and safety

Replies carry `action`, `outcome`, `isError`, `data`, an optional `resultId`, and `notices`. Execution certainty is separate from success:

- `not-sent`: the operation was not dispatched.
- `completed`: the operation completed, possibly with a server-reported error or a local validation failure.
- `unknown`: dispatch may have happened, but completion is unconfirmed.

Check both `outcome` and `isError`. Cancellation, deadlines, and cleanup cannot roll back server side effects. Never replay an unknown or completed operation to recover its output: use `result.read` with the returned `resultId` and follow its `next` offset until it is `null`. Text pages hold a slice of serialized JSON, so do not parse partial pages. `data.origin` preserves the original operation's outcome, error, and validation status.

Output validation uses the tool schema captured before dispatch: `outputValidation` is `"passed"`, `"failed"` (a proven mismatch or missing required output), or `"unavailable"` (local validation could not finish, which is not evidence of bad output). Both failures keep `outcome: "completed"`, set `isError: true`, and retain the output. Schema validation runs in a bounded helper process with no external schema loading; its conservative guards can reject some valid schemas. JSON-RPC errors carry fixed reasons such as `rpc-method-not-found`, `rpc-invalid-params`, or `rpc-header-mismatch`; server messages and data stay private.

Accepted results are retained before inline projection. Disconnect preserves them; disabling, reconfiguring, trust loss, credential changes, logout, eviction, and session replacement revoke them. `/mcp result ID` opens a local viewer that shows recognized text from a complete JSON page, with `v` toggling raw JSON.

| Limit                               | Value                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Config document / one server entry  | 1 MiB / 64 KiB, at most 256 servers                                    |
| Serialized invocation input         | 1 MiB, with structural limits                                          |
| Transport message / accepted result | 8 MiB                                                                  |
| Captured server instructions        | 64 KiB UTF-8 prefix, with explicit truncation evidence                 |
| Inline text and details             | 50 KiB and 2,000 lines                                                 |
| Discovery page                      | 20 entries by default, at most 100                                     |
| Remote discovery traversal          | 64 pages, 1,000 entries per family, 4 MiB metadata                     |
| Retention                           | 32 results and 64 MiB per session, oldest settled result evicted first |
| Native images per reply             | 8, under the separate 8 MiB encoded-data allowance                     |
| Declared image dimensions           | At most 40 million pixels                                              |

Top-level results can include PNG, JPEG, GIF, and WebP images after bounded structural checks; other binary content becomes descriptors. Code Mode receives JSON descriptors rather than image payloads.

Server instructions, descriptions, prompt messages, and resource content are untrusted data. They are never added to the system prompt, prompt roles never become user messages, and the client never follows returned links or opens `file://` paths. These rules reduce accidental authority transfer; they do not make remote content safe from prompt injection.

## Checks

```sh
pnpm --filter pi-mcp test
pnpm --filter pi-mcp typecheck
pnpm --filter pi-mcp effect:diagnostics
pnpm --filter pi-code-mode test
pnpm mcp:smoke
pnpm mcp:conformance
pnpm validate
```

`mcp:smoke` installs pinned real servers and a browser into owned temporary storage and needs network access and macOS. `mcp:conformance` runs the pinned upstream `initialize` and `tools_call` scenarios through the real `McpExecution` and requires confirmed cleanup; it is deliberately not the full suite and is excluded from `pnpm validate`. Historical acceptance evidence lives in the [modernization record](../../docs/plans/pi-mcp-modernization.md#implementation-record) and the [feature record](../../docs/plans/pi-mcp-features.md). None of these checks certify every server, OAuth provider, or OS.
