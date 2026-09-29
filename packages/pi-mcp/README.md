# pi-mcp

A private, local Pi extension with one `mcp` gateway for configured MCP tools, resources, resource templates, and prompts. Code Mode uses the same execution service through the fixed `tools.mcp.request` adapter. MCP works without Code Mode.

The implementation targets macOS. It supports MCP `2026-07-28` and the official client/core SDK 2.0.0's supported legacy revisions over stdio and Streamable HTTP. See the [capability matrix](./CAPABILITIES.md) for implemented behavior, optional features, and restrictions. Historical HTTP+SSE transport is unsupported; SSE within Streamable HTTP remains supported. Apps and tasks are deferred, not deprecated. Sampling and roots are not added. The [feature follow-up record](../../docs/plans/pi-mcp-features.md) tracks current acceptance separately from the historical [modernization record](../../docs/plans/pi-mcp-modernization.md#implementation-record). Neither is a claim of full upstream conformance.

## Setup

From this workspace:

```sh
pnpm install
pi install "$PWD/packages/pi-mcp"
```

For a single session, use `pi -e ./packages/pi-mcp`. Disable or remove another extension that registers `mcp` before switching. This package reports a foreign `mcp` registration and leaves it untouched; it does not uninstall or replace another extension.

Pi/Jiti loads the shipped TypeScript source and fixed validator helper. No build or generated `dist/` is required. There is no importer for another MCP extension's configuration.

## Tool display

MCP honors pi-code-previews' `toolCallCollapsedStyle: "compact"` setting. Pending calls show their action and target; completed replies show semantic counts and one line per warning or error. Expansion adds each issue's recovery detail above the arguments and the labeled readable and raw result. Unknown, malformed, and incomplete historical results keep the detailed renderer rather than hide execution uncertainty. The default `"preview"` style, native images, and machine replies are unchanged.

## Configuration and trust

Configuration loads from these files, in increasing precedence:

1. `<agent-dir>/extensions/pi-mcp.json`, normally `~/.pi/agent/extensions/pi-mcp.json`.
2. `<project>/.mcp.json`.
3. `<project>/.pi/extensions/pi-mcp.json`.

The project is the session's current working directory; parent directories are not searched. The `.pi` directory name follows Pi's exported config-directory constant. Both project files use the format below and require project trust. `.mcp.json` support does not add other clients' transport types or interpolation syntax.

Loading an existing file requires a `mcpServers` object; `version` and `servers` are rejected. A missing file is valid absence. An existing `{}` is invalid when loading or reloading, but an explicit `set-server`, `remove-server`, or `set-settings` command initializes it with `{ "mcpServers": {} }` before applying the change, just as it does for a missing file. Reads never repair files. This initialization applies only to an empty object, not to malformed JSON, nonempty invalid documents, or the old config format.

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

Install the server yourself and replace the example paths. A server with `command` is stdio, and one with `url` is HTTP, so `type` is optional. Supplying both fields or a mismatched `type` is invalid. Stdio launches an executable with an argument array, never an implicit shell. The child inherits only `PATH`, with `/usr/bin:/bin:/usr/sbin:/sbin` as the fallback. Add `HOME`, `TMPDIR`, or credentials through the string-valued `env` map. HTTP `headers` is also a string map. Omitting HTTP `auth` enables implicit OAuth when there are no custom headers. These servers connect anonymously until an authentication challenge or explicit user credential check; no secure-storage lookup or sign-in starts for ordinary anonymous access. With any custom headers, omitted `auth` means no managed authentication and preserves those headers, including Authorization. Set `"auth": false` or `{ "type": "none" }` to disable managed authentication explicitly; reads never rewrite the file. `"auth": true` is rejected rather than interpreted as OAuth. `type: "env"` supplies a managed bearer token. Old `transport`, `environment`, and `{ "env": ... }`/`{ "value": ... }` binding forms are not accepted.

Both transports accept optional `"protocol": "auto"` or `"protocol": "legacy"`. Omission selects modern-first negotiation; `legacy` skips the modern probe for known legacy servers. There are no protocol aliases or automatic configuration migrations. Auto stdio negotiation launches a disposable owned probe child and confirms its process-group and pipe cleanup before launching the application connection. The first connection in a session can therefore run the configured executable twice. Later connections to the same definition in that session reuse only the negotiated era: legacy skips the probe, and modern pins its revision and negotiates on the application child, failing rather than downgrading if the server changed; a failed connection forgets the verdict. The SDK classifies probe replies: authorization failures, server errors, network failures, and HTTP timeouts stay errors, while method-not-found, other client errors such as a stateful 2025 server's uncorrelated `400`, and unusable replies fall back to legacy initialization. A version error listing only newer modern revisions fails as unsupported. The probe waits up to half the connection budget so a cold `npx` or `uvx` start is not mistaken for silence. A probe child that stays silent for that long, or exits cleanly before answering, selects legacy after confirmed child cleanup; explicit legacy mode skips the probe.

Set `"protocol": "legacy"` for a known legacy server to skip the probe. Saved OAuth credentials key on the server's source file, id, URL, and `auth` block only, so changing `protocol`, headers, or tool rules keeps the sign-in. Changing the URL or `auth` block requires `/mcp auth ID` again. Do not copy Keychain records between identities.

An Atlassian `/v2/mcp` endpoint answers the modern probe with HTTP 400 and an uncorrelated `-32600` error; automatic negotiation falls back to legacy MCP `2025-11-25` for it, as it does for other stateful 2025 servers.

Modern list-change subscriptions belong to the connection, not a tool request's deadline. Loss of metadata observation withdraws stale metadata. Status reports the negotiated `protocolVersion` and `observation` health. A failed observation remains visible after disconnection until a successful fresh connection or configuration change. HTTP SSE limits apply to individual events and incomplete input, not total lifetime bytes. A session-bearing legacy POST 404 invalidates the connection without replaying that call. GET 405 or a sessionless GET 404 can decline the optional background channel; GET authorization failures, outages, and session-bearing 404 still invalidate the connection. A later connection requires confirmed cleanup. DELETE 404 establishes remote session absence only; it does not prove that local requests or streams have closed.

At connection time, `${NAME}` in stdio `env` and HTTP `headers` resolves from the captured configuration provider. `$$` produces a literal dollar sign, so `$${NAME}` remains the literal `${NAME}`. Expansion is single-pass. It does not use shell expansion or recurse into substituted values. Only `env` and `headers` values expand; `command`, `args`, `url`, and `cwd` stay literal. Missing variables and expanded values that contain invalid control characters or exceed the configured length are rejected. Values resolve only when needed for connection or authentication, not during status inspection.

Both global and project servers require a trusted Pi session to execute. An untrusted session can inspect local global-config status but cannot read, stat, or write project configuration, resolve credentials, authenticate, connect, or launch servers. Trust does not sandbox a server. A configured MCP executable is trusted local code with the user's OS privileges. Its cwd, tool allow list, and environment policy are not filesystem or network containment.

Settings merge field by field in the order above, starting with defaults. A higher-priority server entry replaces the matching lower-priority entry in full, including its endpoint, headers, and auth configuration. `{ "enabled": false }` suppresses an inherited server. An invalid override disables that server instead of falling back to a lower-priority definition. An unreadable or invalid trusted project document, at either project path, blocks execution rather than ignoring possible overrides.

A stdio server's default cwd is its owning project root or agent directory. Relative `cwd` values resolve against that same directory. `allowTools` and `denyTools` match exact remote tool names; deny wins. An absent allow list permits advertised tools, while `[]` permits none. Denied tools cannot be discovered or called. Resources and prompts follow enabled-server policy, without per-URI or per-prompt rules.

Trusted sessions, enabled servers, and exact-name tool allow/deny rules are the intended MCP authorization model. Per-call approval of tool arguments is an optional future policy, not an implementation defect or a completion requirement for this scope. Permitted tools can run without another confirmation, including sensitive operations. Server annotations never grant permission.

Changes require `/mcp settings reload` or a settings command. There is no watcher, discovery beyond these three paths, automatic package installation, or cross-session metadata cache. Project settings commands write only to `.pi/extensions/pi-mcp.json`; they never modify `.mcp.json`. Writes preserve unrelated JSON fields and reject invalid legacy root fields without rewriting them.

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
/mcp settings
/mcp settings status
/mcp settings reload
/mcp settings set-server global|project ID JSON
/mcp settings remove-server global|project ID
/mcp settings set-settings global|project JSON
```

Everything is one `/mcp` command; typing `/mcp ` autocompletes its subcommands and configured server IDs. Bare `/mcp` and `/mcp status` open the server dashboard in TUI. In RPC and noninteractive modes they return the structured status reply. Bare `/mcp settings` and `/mcp settings help` list the settings commands; `/mcp settings status` shows the configuration. Settings output omits endpoints, commands, environment and header values, and credential identities. For example, `/mcp settings set-settings project {"requestTimeoutMs":90000}` changes one setting. Removing a project override reveals the `.mcp.json` entry, or the global entry if none exists there; use `{ "enabled": false }` to keep it disabled.

### Dashboard and cached metadata

The TUI dashboard lists aligned Server, Scope, and Status columns, with dimmed scope labels and a highlighted selection. Status shows connection state or a configuration/auth warning, without routine auth values. Narrow lists omit columns that do not fit. Server details use a bold name, dim scope/transport, and aligned Status, Auth, and Metadata fields. Highlighted headings and the divider show which pane receives navigation. Activity appears only when work is active or queued. Configuration errors, cleanup/auth recovery warnings, and unavailable-catalog notices remain visible below the summary. Invalid configurations include a bounded field-level explanation and the expected format. Diagnostics never display configured values or arbitrary property names; unknown options get the supported field list. Opening it does not connect, discover metadata, check credentials, or allocate retained results.

Enter inspects a server; `a` opens its action menu without a duplicate Inspect item. The menu highlights Sign in when required, Discover when metadata is missing, or Browse when cached metadata is available, subject to action eligibility. Nothing runs until you choose an action. Logging out, and disconnecting a server with work in progress, ask on the same screen first: Enter confirms and Esc cancels. The typed `/mcp logout` and `/mcp disconnect` commands ask in a Pi dialog instead. Unavailable choices are dimmed with short reasons; selecting one shows the full explanation. `?` expands action descriptions, including Connect's limits. Actions recheck the displayed target after confirmation. Sign in and Connect are separate actions.

First-time metadata guidance points to Discover. Withdrawn, unavailable, refreshing, failed, unsupported, and empty catalogs keep distinct states. Successful discovery reports the full permitted tool count rather than a page length; an unsupported tools catalog is not reported as an empty successful listing. Connect retains its separate credentials-only completion message.

`/mcp browse [ID]` searches all permitted cached tools, resources, templates, and prompts in the selected scope. Use `[` and `]` to change family, `s` to filter servers, and `n`/`p` for pages. Discovery is an explicit server action and may connect. Browsing never invokes tools, reads resources, retrieves prompts, or follows links and schema references. Refresh state remains visible beside retained metadata; revoked content disappears. If an advertised listing method returns JSON-RPC `-32601` on its first page, only that catalog becomes unsupported. Working catalogs remain available, with warnings explaining the unavailable family. Auth, timeout, cleanup, malformed results, and later-page failures do not get this fallback. These views use Cosmic UI navigation, responsive list/detail layouts, and configured key hints. `?` shows navigation help. Browse and result views are TUI-only.

A keyed MCP footer contribution summarizes connected, active, queued, and needs-attention counts. Activity shows actual shared sign-in, connection, and metadata work, including work initiated through Code Mode. It does not create jobs for idle connections or every tool call. Failures retain bounded local explanations. Inspecting Activity opens MCP details, not authentication or replay.

## OAuth

OAuth is HTTP-only and supports public clients with PKCE S256 and token-endpoint auth method `none`. Headerless URL servers can omit `auth`; explicit `{ "type": "oauth" }` requires credentials before connection. Optional registration configurations are:

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

Dynamic registration and Client ID Metadata Documents require the authorization server to advertise support. Dynamic registration uses the SDK's metadata defaults, including native application type for loopback callbacks. This extension does not host a client metadata document or support secret-based client authentication.

A registration that explicitly selects `token_endpoint_auth_method: "none"` may include an unused client secret; the extension discards the secret and its expiry before SDK use or storage. A secret without an explicit method, or any declared non-`none` method, is rejected with a specific diagnostic. Restoration preserves and rechecks the declared method, and refresh stores only the sanitized public-client information.

Dynamic registration saves a sanitized public-client checkpoint before opening the browser, without replacing an existing grant. Later explicit sign-ins can reuse a compatible receipt after cancellation or a previous sign-in. Reuse rechecks identity, issuer, resource, approved scope capacity, and callback binding. Only automatic local callbacks with a revalidated native-client binding may vary the loopback port; configured fixed-port and manual callbacks must match exactly. A rejected reused registration never triggers an automatic fresh-registration retry.

Optional OAuth fields are `issuer`, `resource`, `scopes`, and `redirectUri`. If `registration` is omitted, `clientId` selects pre-registration, `clientMetadataUrl` selects metadata registration, and neither selects dynamic registration.

Omitted `scopes` permits a proposal from a validated Bearer challenge, preferring the original rejected POST's challenge, or from protected-resource metadata. An `insufficient_scope` step-up requests the rejected grant's scopes plus the challenged ones and asks approval only for the new ones. The authorization server may grant different scopes than requested, as RFC 6749 allows; only their syntax is checked. It never requests the authorization server's general scope catalog. Explicit `"scopes": []` requests no scopes and disables inference. During explicit login, an original `insufficient_scope` challenge can propose additions to configured scopes. `offline_access` is added only to a nonempty request when advertised and refresh grants are permitted. Inferred or added permissions require private user confirmation before registration or browser handoff. Approval rechecks the current attempt, abort, trust, and deadline; permission names remain untrusted labels. There is no automatic scope escalation or request replay.

A POST `401` or `403` can retain a bounded `WWW-Authenticate` challenge privately for that operation's later explicit login. It is not a connection-wide last-response hint or public tool data. Login validates that original challenge first. If it lacks a metadata URL, an unauthenticated GET can supply one. GET scope and error fields never become original rejection evidence. A validated `resource_metadata` URL takes precedence over well-known discovery; malformed or unsafe hints fail rather than silently falling back. The GET sends no configured headers or credentials and does not invoke an MCP operation.

When the applicable protected-resource metadata endpoints return only `404` or `410`, login discovers authorization-server metadata at the configured `issuer`, or at the MCP endpoint's origin when no issuer is configured. No provider-specific flag is needed. Endpoint paths, resource overrides, challenge URLs, and redirects cannot select a different fallback origin. Real authorization-server metadata is still required; token and registration endpoints are never guessed.

Set `allowMissingResourceMetadata: false` to require protected-resource metadata. Omission or `true` permits the bounded fallback. Protected-resource discovery does not continue to another candidate after other HTTP errors, malformed responses, network failures, denied redirects, or timeouts. Authorization-server metadata candidates share one issuer, so, like the SDK, a client error or `502` on one moves on to the next; other server errors, network failures, and timeouts stop discovery. Valid resource metadata and explicit issuer pins remain authoritative. Only inferred bare-host issuers accept the equivalent trailing-slash spelling in either direction, and the grant binds to the authorization server's own spelling; configured issuer pins retain exact matching. Resource bindings compare validated canonical URLs, so `https://example.com` and `https://example.com/` are equivalent root resources. Different paths or queries do not become equivalent.

Stored grants record whether metadata was discovered, synthesized from a configured issuer, or synthesized from the endpoint origin. Restoration and refresh recheck that authority; disabling compatibility or changing issuer/resource bindings prevents reuse. Refresh does not rediscover, register a client, open a browser, or replay a failed operation. Discovery failures expose fixed diagnostic reasons, not server response text.

Only an explicit user `/mcp auth ID` command or dashboard Sign in action can start login. An implicit server's first authentication failure activates stored-grant checks for later requests but never replays the failed request. Session replacement clears anonymous-activation evidence, but not a same-process managed-token rejection or unresolved-refresh block. Otherwise implicit servers start anonymously again; explicit OAuth configurations check stored grants before connecting. Local login owns an IPv4 loopback listener, normally `http://127.0.0.1:<ephemeral-port>/callback`, and opens the browser. A configured redirect must be a supported `http://127.0.0.1` callback. `/mcp auth ID --manual` requires a configured fixed-port redirect and collects the full callback URL in a user-only dialog. It does not start a local listener. The provider must support that registered redirect; manual mode is not a promise of universal remote-terminal login.

TUI and supported RPC dialogs can run login. The TUI panel reports actual phases, elapsed time, and the current enforced deadline. Escape cancels that exact attempt and joins owned cleanup. Reopen browser reuses the same validated URL without registering again or extending its deadline. Repeated sign-in requests do not queue another login. Browser-open failure leaves an explicit recovery action.

RPC uses stock private dialogs, never custom overlays. Manual handoff shows the authorization URL in a private confirmation body, followed by callback input; prompt titles are fixed and nonsecret. Local RPC offers explicit reopen/cancel choices while awaiting approval. Print/JSON mode can check an existing grant but cannot prompt or start a listener. These headless checks preserve actionable fixed failure reasons, including rejected tokens and unresolved refresh, rather than replacing every failure with a generic interactive-login requirement. Ordinary gateway and Code Mode calls never open login UI. Authorization URLs, codes, callback URLs, and tokens do not enter tool replies, public progress, Activity, or footer data.

Auth status is observational. `unchecked` means credentials have not been checked in this activation; `required` means missing/rejected credentials or explicit logout; `ready` means the latest applicable check or complete login succeeded; `unavailable` means auth could not be checked; `none` means no managed authentication. Environment-auth readiness means a credential is available, not that a user signed in. Generic permission denial does not invalidate auth evidence. None of these states proves a live connection.

The browser callback page only acknowledges receipt. Pi reports login success after credential persistence and the outer auth fence settle. Cancelling before a replacement grant is saved preserves the prior good grant and any completed registration checkpoint. Cancellation does not log out or undo a native Keychain write. Unresolved mutations remain blocked, and saved credentials followed by failed finalization get a partial-completion explanation rather than success.

The SDK handles discovery, registration, PKCE, exchange, and refresh. Application policy checks issuer/resource binding, callback state and issuer, URL schemes, redirects, and resolved addresses. OAuth HTTP connections use the address set already approved by policy, with no second DNS lookup. Remote endpoints require HTTPS; local HTTP is limited to explicitly configured loopback origins. Discovered private addresses require an explicitly trusted origin. Tokens are not forwarded across redirects.

Authentication failures distinguish the configured mode. HTTP servers with no managed authentication get settings guidance, including checking any configured authentication headers. Environment-auth failures point to the supplied credential, not browser sign-in. OAuth failures point to explicit user sign-in. Implicit OAuth does not start sign-in automatically. These diagnostics use the configuration admitted for the failed request, not a later replacement.

Credentials use macOS Keychain through `@napi-rs/keyring`. There is no plaintext or session-only OAuth fallback. An unavailable store blocks OAuth login and refresh, but not no-auth or environment-auth servers. Credentials are bound to their owning configuration and target, not just the server name. The version 2 record uses the existing Keychain service and account and holds an optional grant and sanitized dynamic-registration checkpoint. It also reads legacy version 1 grants. A registration-only record does not mean the user is signed in.

Credential access rechecks live trust and configuration after lock waits and before refresh or publication, including headless checks. Managed OAuth and environment bearer tokens cannot be sent to remote plaintext HTTP endpoints. Refresh happens before dispatch when needed. When the server rejects an unexpired token and the grant holds a refresh token, the next request refreshes once instead of requiring sign-in; the rejected request is not replayed, and a second rejection within a minute of that recovery requires sign-in. A refresh that fails before its request leaves the process, such as a DNS failure after sleep, keeps the refresh token usable. Before the SDK can consume a refresh token, the store must persist a refresh-quarantine marker. Only a validated replacement grant saved without that marker clears quarantine. Failed, uncertain, or cancelled refresh cannot reuse the old token, including after a sequential process restart. Recovery requires explicit sign-in. A rejected managed OAuth token also stops further token use, even when it has no expiry; that block survives runtime replacement until successful explicit sign-in. Rejected dispatched calls are never replayed.

Credential transactions serialize across cooperating Pi processes for the same Keychain service/account. The private `.cosmic-pi-locks-v1` namespace is beneath the actual OS user's home, independent of `HOME` and agent directories. The lock covers rereading credentials, refresh quarantine and exchange, registration/grant persistence, and logout. A durable journal marks pending native mutations. A dead quiescent owner can be reclaimed; a dead native-pending owner remains blocked because process death does not prove Keychain settlement. Explicit sign-in can recover a quarantined grant, but cannot bypass unresolved native mutation evidence. Managed-token rejection evidence remains process-local, unlike durable refresh quarantine.

Credential-lock admission has a separate 15-second default. The adapter's `acquireTimeoutMs` accepts positive finite values up to 2,147,483,647 ms; it is not the Keychain operation's `timeoutMs` or an MCP configuration setting. Auth authority, local-store, and filesystem queues inherit one monotonic admission budget. Timeout leaves the owner unchanged. Admitted work and native-pending owners do not expire. Local release notifications wake waiters, without a FIFO or waiter-count guarantee. Synchronous filesystem stalls cannot be preempted by that deadline.

### Credential coordination recovery

Normal release validates and best-effort deletes only its own `.released-<token>` artifact. Successful normal transactions leave no growing release history. Cleanup failure can leave an artifact. Dead-owner recovery barriers named `.retired-<token>`, old `.retired` directories, abandoned candidates, and malformed evidence have no online garbage collector or global storage bound.

If coordination reports recovery required:

1. Stop all participating Pi processes and reclaimers, including other sessions and agent directories for the same OS user. Do not run maintenance alongside a process that can acquire these locks.
2. Inspect the reported namespace and artifacts individually. Use reviewed terminal artifacts only for routine offline cleanup; do not delete the lock root or bulk-remove active, malformed, or native-pending evidence.
3. For native-pending evidence, independently establish settlement of the original native Keychain operation before changing any coordination record. PID death, elapsed time, and a fresh login are not settlement proof. If proof is unavailable, leave the evidence in place and seek maintainer-assisted recovery.
4. Preserve durable refresh quarantine. Removing a lock artifact does not make an old refresh token safe. Once native uncertainty is resolved, use explicit `/mcp auth ID` for a quarantined grant.

There is no reset CLI, automatic unsafe reset, or provider-side revocation through this procedure. Do not paste tokens, Keychain values, or authorization/callback URLs into a model conversation.

OAuth logout revokes local auth and connection authority, removes retained results, and deletes both the grant and registration checkpoint. It does not revoke tokens at the provider. Environment and no-auth servers reject logout as unsupported. Failed Keychain deletion is reported as a failure, not a successful logout. Native Keychain create/read/replace/delete and absence checks passed in a disposable namespace; see the [acceptance record](../../docs/plans/pi-mcp.md#acceptance-record).

## Gateway and Code Mode

The gateway accepts an explicit `action`; omitting it means `status`. Each action rejects unrelated fields. Rejected gateway and Code Mode request shapes return fixed action-specific repair guidance without echoing supplied values or arbitrary property names. Unsafe or oversized input and unknown actions keep generic rejection guidance. `status` accepts only `action`, never `server`. List/search `limit` is 1 to 100 entries; `result.read` accepts 1 to 50,000 UTF-16 code units and may return less to fit the output allowance. `prompts.get` arguments must be string-valued; `tools.call` arguments follow the described tool schema. For missing required or unexpected prompt arguments, both the gateway and Code Mode suggest `prompts.list` on the same server.

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

`completion.complete` completes an argument for an exact advertised prompt or resource template, when the server advertises completions. The `ref` is either `{ "type": "ref/prompt", "name": "review" }` or `{ "type": "ref/resource", "uri": "files:///{path}" }`. Resource completion uses the template URI, not a fetched resource. For example:

```json
{
  "action": "completion.complete",
  "server": "files",
  "ref": { "type": "ref/prompt", "name": "review" },
  "argument": { "name": "language", "value": "ty" },
  "context": { "arguments": { "style": "brief" } }
}
```

Use only names and context arguments from that server's metadata. Results contain at most 100 completion values. `events.read` reads bounded local observations without connecting or sending a remote request, for example `{ "action": "events.read", "server": "files", "limit": 20 }`. Follow its returned decimal-string `next` cursor; numeric cursors are invalid. The default page has 32 events, with `limit` from 1 to 100. The session ring holds at most 128 events and 128 KiB, with log/progress text capped at 4 KiB and progress coalesced per operation. `truncated` reports evicted history. Earlier transport-ingress drops may not appear in that flag. Observations are best-effort evidence, not a durable audit log or operation results.

`resources.subscribe` explicitly subscribes to one URI on a server advertising resource subscriptions. `resources.unsubscribe` closes the matching owned subscription without opening a new connection; `resources.subscriptions` lists local active subscriptions without remote I/O. Repeating an active subscribe returns `existing: true`; an absent unsubscribe returns `existing: false`. Subscriptions hold connection-owned leases, capped at 16 per connection owner and 32 per session. Updates enter `events.read`; they never trigger automatic resource reads. Disconnect, authority loss, or stream closure ends the lease. There is no automatic reconnect or re-listening.

Modern updates must match the SDK-generated subscription ID and acknowledged URI filter. Both eras allocate a private local identity before acquisition and recheck it before publication, so queued updates cannot revive after same-URI replacement. Modern ACK-adjacent staging holds at most 32 updates until SDK/filter acceptance; overflow is reported. One owner finalizer retains only current entries, not every historical subscription. Legacy wire notifications have no generation ID; this check cannot distinguish old server work first received after replacement. HTTP close joins actual source cancellation. Stdio close checks native cancellation-write settlement or exact remote termination, not SDK logical close. A successful write is not a remote acknowledgement. Failed writes retain the lease until child cleanup; uncertain legacy establishment before acknowledgement retires the connection.

`logLevel` is explicit opt-in compatibility for deprecated MCP structured Logging, which is deprecated in `2026-07-28`. Values are `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, or `emergency`. Omitting it does not enable global logging. Per-request logging requires modern Streamable HTTP and advertised logging support. Legacy transports and modern stdio reject `logLevel` before dispatch rather than enabling connection-wide logging. HTTP logs require exact request-stream provenance and severity filtering. Progress works on both transports and reaches bounded live top-level gateway updates as well as local observations. Progress is not deprecated and never establishes completion. There is no OpenTelemetry exporter. The [feature record](../../docs/plans/pi-mcp-features.md) tracks final acceptance.

`server.instructions` returns server-wide guidance captured once during initialization. It may connect the selected server, but it does not list tools or send an application RPC. For example, `mcp({ "action": "server.instructions", "server": "files" })` returns `data.result` with `{ "server": "files", "truncated": false, "instructions": "..." }`. Missing instructions are `null`; an explicitly supplied empty string stays empty. The action is also available through Code Mode.

Capture keeps at most a 64 KiB UTF-8 prefix without splitting code points. `data.result.truncated` reports capture truncation; the discarded suffix is not recoverable. Output pagination is separate: `result.read` can recover the retained prefix, even after disconnect, subject to the usual revocation rules. Notices are best-effort under output budgets, so retain the `truncated` field when extracting content. Instructions remain untrusted data and are never injected into the system prompt or treated as permissions.

`tools.list` and `tools.search` return compact selection entries by default, with no full-results mode. Entries preserve exact `server` and `name`, an optional title capped at 128 Unicode code points, and the first nonempty description paragraph capped at 512 code points. Whitespace is normalized; `titleTruncated` and `descriptionTruncated` disclose omitted text. Titles prefer the top-level title, then `annotations.title`. Only advertised boolean `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` annotations are copied. Missing hints remain unknown, and no hint grants permission. Schemas, examples, icons, and arbitrary extension fields are omitted.

Use `tools.describe` for an unfamiliar tool's complete definition and instructions before constructing arguments. If its output is truncated, recover the retained pages rather than guessing a missing schema. Discovery retains full immutable definitions internally, and invocation still validates against the complete current schema. Input/output schema literals remain unchanged in descriptions and retained pages, even when their JSON fields resemble binary attachments.

Search examines full names, titles, and descriptions, including text omitted from summaries. Exact names rank first, then name-token matches, title matches, and description matches. Multiword searches handle camelCase and common separators; all words must match. Equal ranks sort by exact server/name identity. Cached browsing uses the same ranking and also searches resource/template identifiers. Only the selected page is projected into response objects. Search covers advertised metadata, not operations hidden behind dispatcher tools. A zero-match search suggests inspecting `tools.list`, then `tools.describe` for relevant discovery/dispatcher tools or `server.instructions` before concluding the operation is unsupported. This guidance never invokes those tools or authorizes following server instructions automatically.

Invocation needs exact `server` and `tool` fields, without aliases or fuzzy matching. Targeted discovery may connect lazily; unscoped list/search only inspect cached snapshots and report undiscovered servers. An empty page can mean nothing has been discovered yet, not that no tools exist. When `data.result.undiscovered` is nonempty, select a relevant ID as `server` in a targeted list/search. Status never connects. Cursors belong to a frozen metadata revision and become invalid when it changes.

Metadata freshness uses each page's `ttlMs` and `cacheScope`. Missing, zero, negative zero, invalid, or negative TTL gives no reusable freshness, as the specification defines. A TTL over one day is clamped to one day. The complete revision takes the earliest page and catalog expiry and the most restrictive scope. A targeted initial lookup reacquires expired or absent-TTL metadata; a newly acquired zero-TTL revision serves that acquisition once without looping. Cursor continuations instead read the current cached revision locally even after TTL expiry, so zero-TTL pagination works. Explicit refresh, list-change notifications, and auth/configuration invalidation invalidate those cursors. Invocation does not wait on TTL: like the SDK's call-time tool index, `tools.call`, `prompts.get`, and completion reuse the current revision until a list-change notification, failed refresh, reconnection, or auth/configuration change invalidates it. A server without TTL hints is therefore listed once per connection, not before every call. This does not introduce polling. Passive dashboard browsing and unscoped list/search stay local and mark stale metadata rather than silently connecting. Observation loss and authority revocation still withdraw content. Even `cacheScope: "public"` cannot cross an auth-context change, configuration identity, or session in this cache.

A failed refresh can leave previous authorized metadata visible to passive browsing with a warning. That warning is not permission to use an expired schema for active dispatch. Successful refresh clears the warning on new replies; retained results keep their original notices. A changed managed credential retires the old connection owner before metadata or dispatch can reuse its schemas. A later fresh request must acquire a new owner after confirmed cleanup; credential refresh does not automatically retry the interrupted operation.

For modern HTTP, `x-mcp-header` annotations mirror validated string, integer, or boolean arguments into `Mcp-Param-*` headers. `number` is rejected even if an SDK accepts it. Invalid annotations exclude the whole tool from discovery and invocation with a bounded diagnostic. Headers must have unique case-insensitive token names and resolvable property paths. There are at most 64 parameter headers and 16 KiB of encoded header data. Values must match their declared string, safe-integer, or boolean type. Invalid UTF-16 is rejected rather than silently replaced. Unsafe HTTP characters use MCP's base64 encoding, with the final encoded bound checked before HTTP send; optional absent values are not mirrored. Stdio and legacy connections do not apply this modern-HTTP requirement.

Code Mode exposes these data actions through `tools.mcp.request`, but excludes `connect`, `disconnect`, `refresh`, auth, configuration writes, and arbitrary protocol methods. It requires exactly one active provider in the same stable Pi session and rechecks that provider on each request. Merely importing the protocol does not load the extension.

Pi has no built-in approval middleware. Nested MCP calls bypass its `tool_call`/`tool_result` hooks, any checks supplied by unrelated optional extensions, registered tool overrides, and previews. The shared MCP execution service still applies trust, server policy, validation, admission, and result limits. Only the outer `code_mode` call follows the ordinary Pi middleware path. See the [Code Mode README](../pi-code-mode/README.md#mcp-adapter).

## Private modern user input

Only modern `tools.call`, `resources.read`, and `prompts.get` continue multi-round-trip input-required exchanges through a current same-session `pi-ask-user` TUI/RPC form provider. The same gateway and Code Mode execution path owns the operation; no extra executor or public answer action is added. SDK construction uses empty client capabilities. Elicitation is advertised per request only with a current provider, never for headless or legacy sessions. Legacy server-driven elicitation remains unsupported.

MCP translates only flat object schemas with up to 16 fields into Ask User forms. Supported fields are string, number, integer, boolean, string enum, and string-enum arrays, with bounded defaults and constraints and only `email`, `uri`, `date`, and `date-time` formats. Nested objects, references, unsupported keywords, and type-incompatible constraints are rejected before any form in that batch opens. Ask User checks each form's defaults and constraint consistency before presenting it. The sensitive-field check is a text-pattern heuristic, not a complete secret detector.

An operation allows at most 8 dispatch rounds and 16 input requests. Input-request batches, response batches, and opaque state each have a 64 KiB bound. MCP limits enum choices to 64 total across a form; Ask User itself permits 64 per enum field. Messages/string values have a 4,096-code-unit bound. The client keeps `inputResponses`, opaque `requestState`, and collected answers private to the operation rather than publishing them to model replies, retained results, events, or Activity.

URL elicitation shows the full inert URL and prominent host for user consent, with an 8,192-code-unit limit. URLs require HTTPS, or HTTP on an explicit loopback hostname, and cannot contain credentials, ASCII whitespace, or control characters. Ask User neither fetches nor opens them. MCP rechecks operation and provider authority before private macOS system-browser navigation, then asks the user to continue or cancel. It neither polls the URL nor infers completion from browser opening.

Continuation authority is stricter than completed-result publication authority. After an authentication rejection stops a connection accepting work, no further form, browser action, or continuation can start, while a separately completed reply can still publish under its captured current authority. Cancellation, provider loss, failed cleanup, and round limits never authorize replay.

MCP waits at most one second for exact-owner Ask User cancellation. Timeout or rejection is unconfirmed cleanup, not success. A module-wide process-local fence blocks all later MCP form-provider resolution across runtime and session replacement until that exact cancellation Promise succeeds. Rejection leaves the fence in place; replacing the MCP runtime cannot clear it. Final acceptance remains in the [feature record](../../docs/plans/pi-mcp-features.md).

## Results and safety

Replies carry `action`, `outcome`, `isError`, `data`, optional `resultId`, and `notices`. Execution certainty is separate from success:

- `not-sent`: the operation was not dispatched.
- `completed`: the operation completed, possibly with a server-reported error or a local validation failure.
- `unknown`: dispatch may have happened, but completion is unconfirmed.

Check both `outcome` and `isError`. Unknown failures retain fixed diagnostic reasons, including protocol compatibility and authentication guidance, in gateway, Code Mode, and user-command replies. Discovery failures identify connection or metadata work and clarify that no tool invocation was requested; this does not assert that the server had no side effects or permit automatic replay. Output validation or projection can fail after the remote operation completed. Cancellation, deadlines, and cleanup cannot roll back server side effects. Never replay an unknown or completed operation just to recover output. Use `result.read` when a result ID is present; follow its returned `next` offset rather than calculating byte offsets. Retrieval preserves the original operation's outcome and error status under `data.origin`.

Full projected payloads are under `data.result`, alongside `data.origin`. Text pages instead contain `data.text`, `offset`, `next`, and `total`; the text is a slice of serialized JSON, not necessarily a complete JSON document. Text-only `result.read` always returns this page shape, even when the whole result fits. Follow the returned `next` until it is `null`; do not parse partial JSON. Attachment reads use `data.attachment` instead. Failed requests or omitted output may have neither `result` nor `text`, so check the reply before extracting either. A successful `result.read` reports successful retrieval only; preserve `data.origin` to check the originating operation's outcome, error, and output-validation status.

Schema validation runs in a fixed, bounded helper process, not on Pi's thread. Pi first applies the helper's schema policy without following references, so a schema with unsupported features is rejected before any helper process starts. Valid identifiers and annotations do not authorize network access, file reads, content decoding, or plugins. The validator compiles synchronously with no external schema loader. References must resolve within supplied or bundled schemas. The helper's conservative guards can reject otherwise valid schemas, including ambiguous resource scopes and unsupported engine extensions; this is not complete JSON Schema dialect certification.

Output validation uses the tool schema captured before dispatch. `outputValidation: "passed"` confirms a match, `"failed"` means a proven mismatch or missing required structured output, and `"unavailable"` means local validation could not finish. Unavailable validation is not evidence of invalid server output. Failed and unavailable validation both keep `outcome: "completed"`, set `isError: true`, and retain accepted output under the normal limits and authority checks. Recover it with `result.read`, never by replaying the call.

HTTP and stdio JSON-RPC errors retain fixed diagnostic reasons such as `rpc-method-not-found` or `rpc-invalid-params`, rather than appearing as transport failures. Raw server messages and error data stay private. A completed failure does not prove that output was retained; error guidance does not offer retained-output recovery without a result ID.

The owned gateway has compact call/result cards under the existing code-preview shell. Expanded cards show recognized MCP text with its newlines and indentation, alongside sanitized raw JSON. One combined display budget covers both sections. String, collection, depth, node, line, and character cuts are disclosed separately from source truncation or operation failure. Expansion never changes the original JSON, images, error receipts, or execution certainty. Unknown completion, cleanup, truncation, and originating failures remain visible when collapsed. Ordinary cancellations use operation-neutral guidance, not sign-in instructions.

Standalone and nested calls share MCP's outcome and recovery projection, including retained
origins, output validation, cleanup, and output-loss access instructions. Code Mode retains its
own call lifecycle and delivery evidence; it does not reinterpret MCP result bodies.

Standalone and nested compact calls share discovery notice relevance. Routine cache freshness
and missing optional resource/template catalogs stay in expanded details during tool search or
description. Missing support for a catalog you actually requested, failed refreshes, and unknown
notices remain visible. Cached searches still disclose undiscovered servers.

Successful discovery pages with a next cursor show counts and more-metadata availability without a recovery warning solely for pagination. Short pages missing a cursor and actual output limits still show recovery guidance. Cards consolidate recognized local validation notices into one complete warning without changing model-facing output. Failed validation and unavailable validation remain distinct, and neither permits replay to recover output.

`/mcp result ID` opens an authorized local retained-output viewer. A complete JSON page containing recognized tool, resource, or prompt text defaults to readable text; `v` toggles sanitized raw JSON. Partial pages stay raw, even when a fragment happens to parse as JSON. The viewer keeps its existing 8,192-character read allowance and never assembles pages to enable readable mode. Raw view retains page-sized strings and collections rather than applying the card's smaller cuts.

Mode changes perform no reads or execution. Navigation follows original returned offsets, not sanitized text lengths, and preserves the originating outcome. The viewer keeps one authorized page and bounded previous offsets. Eviction or revocation withdraws both views; recovery never reruns the source operation. There is no new result-history store. Display sanitization is not a guarantee that arbitrary remote content contains no sensitive information.

Accepted results are retained before inline projection. Disconnect preserves completed results. Disable, reconfigure, trust loss, credential changes, logout, eviction, and session replacement revoke them. Local discovery/status retention also binds the current revocation generation, so an unchanged configuration revision cannot revive old local results. A retention failure explicitly says the output is not recoverable. Oversized wire responses may never reach retention.

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

Top-level results can include PNG, JPEG, GIF, and WebP images. Checks cover bounded base64, MIME, headers/container structure, and declared dimensions, not full image decompression or validation of every frame. Audio and other binary content become descriptors or omission notices. `result.read` can select a stored supported image by attachment index. Code Mode receives JSON descriptors for recognized binary envelopes, not their base64 payloads or native images. Ordinary text remains text; the client does not reinterpret arbitrary encoded strings. Code Mode's remaining output budget can lower the projection limit.

Server instructions, descriptions, prompt messages, and resource content are untrusted data. They are not added to the system prompt or treated as commands. Prompt roles remain data, not new user messages or slash commands. Resource reads route only through the selected server. The client never independently fetches returned HTTP links, opens `file://` paths, or follows resource links automatically. These rules reduce accidental authority transfer; they do not make remote content safe from prompt injection.

## Compatibility and checks

The checks below are historical modernization evidence, not acceptance of the feature follow-up. Current verification and remaining gates belong in the [feature record](../../docs/plans/pi-mcp-features.md); the [matrix](./CAPABILITIES.md) separates owned regressions from external checks.

The modernization macOS real-server smoke passed through `McpExecution` using automatic negotiation, selecting legacy protocol `2025-11-25`:

- `@modelcontextprotocol/server-filesystem@2026.8.31`: 14 tools, read/write, input/output validation, and bounded recovery of an 80 KB retained result.
- `@playwright/mcp@0.0.80`: 24 tools, isolated browser navigation to an owned local page, snapshot, evaluation, and close. Its Playwright manifest was `1.63.0-alpha-2026-08-31`, with Chromium `153.0.8010.12`, revision `1243`.

The smoke verified cleanup of owned processes, temporary installation, browser, and profile. Owned modern HTTP and stdio fixtures exercise the real SDK, `makeMcpLayer`, and `McpExecution`, including tools, resources, templates, prompts, subscriptions, and disconnect. OAuth fixtures use owned boundaries and real child processes for credential races and crash recovery. A separate disposable macOS Keychain check passed create/read/replace/delete and absence checks. Workspace validation and clean-consumer packed-source checks passed. The [modernization record](../../docs/plans/pi-mcp-modernization.md#implementation-record) records commands and limitations. These checks do not certify every server, OAuth provider, or OS.

```sh
pnpm --filter pi-mcp test
pnpm --filter pi-mcp typecheck
pnpm --filter pi-mcp effect:diagnostics
pnpm --filter pi-code-mode test
pnpm mcp:smoke
pnpm mcp:conformance
pnpm validate
```

`mcp:conformance` is an opt-in check using pinned `@modelcontextprotocol/conformance@0.1.16`. It runs only `initialize` and `tools_call`, sequentially, through the real `makeMcpLayer` and `McpExecution`, with explicit legacy protocol selection for these legacy scenarios. Each scenario uses disposable agent/project directories and a no-auth loopback server. A pass requires both the upstream checks and a driver receipt written after explicit confirmed disconnect and scoped cleanup. Crashes, timeouts, missing receipts, and unconfirmed cleanup fail the command. No expected-failure baseline hides failures.

This is deliberately not the full conformance suite. OAuth/auth scenarios, elicitation, SSE retry, compatibility, draft, and extension scenarios are excluded. The grader is a development dependency only; it does not change the runtime SDK or add protocol capabilities. The command needs POSIX process groups and is excluded from `pnpm validate`. It was verified on macOS and does not establish conformance for every server, transport, or authorization flow.

The [modernization record](../../docs/plans/pi-mcp-modernization.md#implementation-record) preserves its historical acceptance separately. The pinned upstream scenarios above do not establish broader modern-protocol conformance. Legacy HTTP expiration handling must preserve the failed call's execution certainty and prohibit replay, even when DELETE 404 confirms remote absence. Native cleanup still needs separate confirmation.

`mcp:smoke` installs pinned servers and downloads a browser into owned temporary storage. It needs network access and macOS, but no user account credentials. See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and cleanup boundaries.
