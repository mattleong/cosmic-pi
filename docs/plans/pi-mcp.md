# pi-mcp implementation plan

Status: implemented and validated. The private source-only Pi extension includes the gateway, version 1 configuration, session connections, discovery, isolated validation, retained results, public-client OAuth/Keychain, resources/prompts, user commands, and the fixed Code Mode adapter. `pnpm validate`, packed-source installation, real filesystem/Playwright compatibility, native Keychain acceptance, and the public Pi error-result proof passed. See the [acceptance record](#acceptance-record) for the tested modes.

## Agreed scope

Build `packages/pi-mcp/` as an option 2 replacement for the installed MCP extension.

- One model-facing `mcp` gateway.
- MCP tools, resources, resource templates, and prompt templates.
- Local stdio and remote Streamable HTTP connections.
- Authentication, including OAuth.
- Code Mode batches MCP operations through the same execution service. Its fixed `tools.mcp.request` adapter includes bounded discovery, resource/prompt, and retained-result operations.
- Fresh configuration. No importer or compatibility layer for the installed extension.
- macOS first. Keep portable interfaces, but Linux and Windows support are not v1 acceptance requirements.
- Representative compatibility tests: filesystem and Playwright MCP servers, plus owned HTTP/OAuth fixtures. No user-account access is required.

Do not implement individual MCP tool registration, per-server proxy tools, `mcpScript`, MCP Apps, elicitation, or sampling. Prompt templates are retrieved through the gateway, not installed as slash commands. The package must work without Code Mode being active.

The user selected option 2. The decisions below define the implemented contract and its acceptance requirements. The [package README](../../packages/pi-mcp/README.md) documents setup and exact commands; the [package architecture](../../packages/pi-mcp/ARCHITECTURE.md) documents current ownership.

## Reference and constraints

The reference is the installed `pi-mcp-adapter@2.32.1`, not a runtime dependency. Useful reference files are `server-manager.ts`, `config.ts`, `metadata-cache.ts`, `tool-registrar.ts`, `mcp-output-guard.ts`, and the `mcp-auth*` modules. Its Apps host, scripting worker, direct-tool registry, config importers, and native-window support are outside this plan.

Follow the repository's [Effect architecture](../architecture/effect-v4.md), [host boundaries](../architecture/pi-boundaries.md), and [testing policy](../architecture/testing.md). Ship TypeScript source through Pi/Jiti, use the synchronized workspace version, and add no generated `dist/` runtime requirement.

### Use the official SDK

Use the official TypeScript MCP SDK, starting with the reference extension's exact `@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/core@2.0.0` versions. Verify their published entrypoints during implementation and pin the selected versions in the workspace catalog. Declare only packages we actually import.

The user approved SDK-internal transitive Zod dependencies. Our code still uses Effect Schema and does not import Zod, define Zod schemas, or declare Zod directly. SDK-internal schemas do not require a second application schema system.

The SDK owns MCP framing, request correlation, version-specific wire behavior, standard transports, and OAuth protocol helpers. Named package-local adapters translate its Promise/callback APIs into scoped Effect operations and redacted typed failures. Our services own application policy, request admission, credentials, metadata snapshots, and result retention. Do not reimplement the SDK, replace it with Effect's server APIs, or build a generic MCP SDK in Cosmic Core.

### SDK integration acceptance

The integration milestone requires:

1. Prove a stdio and Streamable HTTP tool-call flow using the published SDK, through our named Effect boundaries. Record the tested protocol/server matrix and initialization options.
2. Prove interruption, scope closure, partial acquisition cleanup, and confirmed child-process cleanup. Do not equate an aborted waiter or resolved SDK close call with complete transport cleanup.
3. Verify wire/output byte limits and SDK validation hooks, including work the SDK performs before results reach application code. Effect timeouts alone cannot interrupt synchronous validation.
4. Verify and control SDK-internal retries and automatic auth so they cannot replay uncertain tool calls or unexpectedly open a browser.
5. Prove pinned-Pi tool-error delivery with retained result details.
6. Select the macOS secure-storage adapter and verify Keychain availability, supported OAuth registration methods, and local/manual callback behavior. Cross-platform storage and process-cleanup validation are deferred.

Use SDK transports and their supported customization points first. Core's current HTTP helper lacks response headers/DELETE, and its process helper is not a duplex client transport; SDK adoption removes the need to expand those APIs merely to recreate MCP. Add a shared platform capability only if a demonstrated cleanup, isolation, or bounded-I/O gap requires it. Stop and review such a gap rather than silently forking the SDK or weakening a safety guarantee.

### Protocol compatibility

- Start with the SDK's default legacy negotiation, not an exact-version rejection rule. SDK 2.0.0 also supports opt-in modern `2026-07-28` negotiation. Enable that only after the same lifecycle, no-replay, and compatibility fixtures pass. Installing SDK 2.0.0 alone does not enable modern negotiation.
- Let the SDK implement initialization, version-specific request envelopes, headers, session handling, correlation, pings, and protocol cancellation. Advertise no Apps, elicitation, sampling, roots, or tasks capabilities. Do not add handlers that fulfill unsupported server requests automatically.
- Use SDK stdio and Streamable HTTP transports. Test bounded stdio output and both JSON/SSE HTTP responses at our boundary. stderr stays bounded diagnostic input and never writes directly into Pi's terminal.
- SDK HTTP notification streams and reconnection are allowed only under session ownership and bounded reconnect policy. Resuming a notification stream must never become permission to replay an application request. Keep resource subscriptions outside the public API.
- Close owned streams on completion or interruption. Verify the SDK's explicit HTTP session-termination behavior and distinguish local cleanup from any guarantee that a remote server stopped work.
- Modern negotiation can create a disposable stdio probe process. Track its acquisition and confirm its cleanup as well as the main server process; one logical connection does not necessarily mean one process.
- List methods use opaque remote cursors. Continue until `nextCursor` is absent, not merely falsy. Bound traversal and detect repeated cursors. Gateway cursors identify our frozen metadata snapshots rather than exposing raw server cursors.

## Gateway contract

Use one explicit action discriminator rather than the reference extension's precedence between unrelated fields. An omitted action means `status`. Reject fields that do not belong to the selected action.

| Action                                  | Purpose                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `status`                                | Report configured servers, connection/auth state, and known metadata counts. No connection side effects. |
| `connect`, `disconnect`                 | Open or close one configured server connection.                                                          |
| `refresh`                               | Refresh one server's advertised metadata.                                                                |
| `tools.list`, `tools.search`            | Return bounded discovery pages. Search covers known metadata and reports servers not yet discovered.     |
| `tools.describe`                        | Return one tool's description, input/output schemas, and annotations.                                    |
| `tools.call`                            | Invoke one tool with `{ server, tool, arguments }`.                                                      |
| `resources.list`, `resources.templates` | List resources and URI templates for one server.                                                         |
| `resources.read`                        | Read an explicit URI through the selected MCP server.                                                    |
| `prompts.list`, `prompts.get`           | Discover a prompt or retrieve its messages using string-valued arguments.                                |
| `result.read`                           | Retrieve a bounded text/JSON slice or supported attachment from a retained result.                       |

Server IDs and original remote tool names are separate fields. There are no flattened names, aliases, or fuzzy invocation. Search may rank approximate matches; invocation always requires an exact match.

Targeted discovery may lazily connect its server. Unscoped search must not launch every configured command or open authentication flows. Return undiscovered server IDs so the model can choose what to connect.

Descriptions, server instructions, resource text, and prompt messages are untrusted data. Do not append them to the system prompt, execute returned commands, install slash commands, or inject prompt results as user messages. Preserve prompt message roles as data for the caller to inspect.

Resource URIs route only through the selected server's `resources/read`. The client must not independently fetch an HTTP URI or read a `file://` URI from its own filesystem.

### User commands

The implemented argument-first commands are `/mcp status`, `/mcp connect ID`, `/mcp disconnect ID`, `/mcp refresh ID`, `/mcp auth ID [--manual]`, and `/mcp logout ID`. Bare `/mcp` means status, which opens the dashboard in a terminal. Persistent editing uses `/mcp-settings status`, `help`, `reload`, `set-server global|project ID JSON`, `remove-server global|project ID`, and `set-settings global|project JSON`; bare `/mcp-settings` means help. There is no custom picker. Supported TUI/RPC dialogs run explicit login; print/JSON mode can check existing credentials but cannot prompt or start a callback listener.

Authentication starts from an explicit user command. An ordinary gateway or Code Mode call returns `AuthRequired` instead of opening a browser unexpectedly. Authorization codes, callback URLs containing codes, tokens, and client secrets never pass through model-facing tool parameters or results.

Detect an existing foreign `mcp` registration before installing ours. Report the conflict and leave its tools untouched. Switching extensions is an explicit user setup step, not an automatic uninstall or override.

## Configuration and trust

Use versioned documents at:

- `<agent-dir>/extensions/pi-mcp.json`
- `<cwd>/<Pi config directory>/extensions/pi-mcp.json`

Resolve the project directory with Pi's exported config-directory constant. Version 1 execution requires a trusted session, for both global and project servers. An untrusted session may show local global-config status, but performs no project-config reads/stats/writes, credential resolution, authentication, network calls, or server launches. This matches Code Mode's trust gate. A configured MCP executable remains trusted local code with the user's OS privileges, not a process confined by an OS sandbox.

A document contains `version`, package settings, and a server map keyed by stable user-chosen IDs. Each enabled server declares exactly one transport:

- `stdio`: executable, argument array, optional cwd, and explicit environment bindings. No implicit shell.
- `http`: endpoint URL, explicit header bindings, and authentication configuration.

A server has `enabled`, optional `allowTools`, and optional `denyTools`. Enabled servers allow all advertised tools when `allowTools` is absent; an empty allow list allows none. Lists match exact original tool names and denial wins. Denied tools are absent from list/search/describe and cannot be called. Apply this policy identically through the gateway and Code Mode. Resources and prompts are allowed at the enabled-server level in v1; no per-URI or per-prompt rules or per-call approval subsystem is promised.

Environment references are resolved only when connecting or authenticating. Do not support shell commands embedded in config values, automatic `npx` installation, host-config discovery, or package-provided MCP definitions in v1. The user can explicitly configure an executable such as `npx`; that remains a trusted process launch.

The macOS child-environment baseline is only `PATH`, inherited from the host or `/usr/bin:/bin:/usr/sbin:/sbin` when absent. `environment` entries explicitly add or replace values through `{ "env": "NAME" }` or `{ "value": "literal" }` bindings. `HOME` and `TMPDIR` are not inherited unless configured. HTTP `headers` use the same binding form; `auth: { "type": "env", "env": "NAME" }` supplies a bearer token. Do not copy the entire Pi environment or inject its model credentials. Default project-server cwd is the trusted project root and global-server cwd is the agent directory. Relative cwd resolves against that same owning scope. None of these choices confines what the executable can do.

A project server entry replaces the same global server entry as a whole. Do not merge a new endpoint with inherited headers or credentials. Support an explicit disabled entry to suppress an inherited server. Malformed overrides disable that effective server with a diagnostic instead of silently activating the global definition.

Credential identity includes the config scope, server identity, effective endpoint, OAuth issuer/resource, and client identity as applicable. Reusing a name or changing its target must not reuse another target's credentials.

`config/store.ts` is the only config persistence API. Documents require `version: 1`. Use core atomic document operations with the per-call `maxBytes` bound before JSON parsing and before committing the serialized replacement, including formatting and its trailing newline. Preserve unrelated fields on writes, reject unknown document versions, and commit authoritative state with the persisted document. Structural limits still apply after parsing. Apply changes through an explicit reload/reconfigure operation, not a filesystem watcher.

## Connection ownership and concurrency

Create one Effect runtime at `session_start`. Each server connection has an owned child scope containing transport resources, in-flight requests, metadata, timers, and finalizers. No processes or sockets start in the extension factory.

- Default to lazy connection with an idle timeout. Active requests prevent idle shutdown.
- Deduplicate concurrent connection and metadata-refresh attempts per server. Cancelling one waiter must not cancel work another admitted waiter still needs. The shared owner has its own bounded deadline and session scope.
- Use explicit per-server and session-wide call limits with a bounded admission queue. Do not gate SDK control traffic behind those application permits, so cancellation and pings cannot deadlock behind saturated calls.
- Do not hold a registry lock while waiting on remote I/O, user auth, or cleanup.
- Treat metadata as session-local. Tool/resource/template/prompt lists expose frozen snapshots, not live remote pages. Initial targeted discovery and explicit refresh populate them.
- Coalesce delivered list-change notifications. Publish a complete new metadata revision, never a partially fetched list. Explicit refresh remains available when a server or transport does not deliver notifications.
- Bind gateway continuation cursors to the server and metadata revision. Reject stale cursors rather than mixing pages from different lists.
- Revalidate trust, effective server configuration, session identity, and tool allow/deny policy at admission and after any queued wait.
- Disconnect, disable, reconfigure, trust loss, replacement, and shutdown revoke new-call authority before interrupting active work and joining cleanup.
- Do not claim process cleanup merely because a kill request succeeded. Unconfirmed cleanup prevents a replacement process from starting for that server.

The request deadline starts at admission and includes queueing, lazy connection, credential refresh, validation, remote I/O, and result projection. Interactive login is a separate user-owned operation. An individual request's cancellation revokes its publication authority, removes its application admission/queue state, and forwards the abort signal to the SDK. The SDK owns correlation cleanup and best-effort protocol cancellation. Ignore late SDK settlement; never publish it into a replacement session. Transport failure may settle all affected requests, but cancelling one caller must not close a healthy shared connection.

A cancelled or timed-out remote call may already have changed external state. Never automatically replay a tool call after dispatch, including after an HTTP session expires or authentication fails. Reconnection may make a future explicit call possible; it is not permission to repeat the old one. Only pre-dispatch connection work and standard metadata-list discovery may have a bounded retry policy within the original deadline. Resource reads and prompt retrieval are not assumed safe to replay.

Caller settlement and transport/process cleanup are distinct. A cancelled caller can settle while a revoked connection scope still confirms cleanup; replacement admission remains blocked until ownership is resolved.

## Authentication

Support no-auth servers and explicit environment-backed credentials. OAuth applies to HTTP servers; stdio gets its configured credentials through the child environment. Reuse core HTTP/file/platform services where they fit; own OAuth protocol policy in `pi-mcp`.

Use the SDK's OAuth helpers rather than implementing discovery, PKCE, code exchange, and registration ourselves. Support pre-registered public clients and SDK-managed dynamic registration where the authorization server advertises it and the destination passes our policy. A user-configured Client ID Metadata Document URL can also use the SDK's supported path; we do not need to host that document. Confidential-client methods and operating our own public metadata endpoint remain deferred.

The public `registration` values are `pre-registered`, `dynamic`, and `metadata`. They require `clientId`, advertised dynamic registration, or `clientMetadataUrl` respectively. Only public clients with token-endpoint method `none` and PKCE S256 are supported. Owned fixtures exercise these paths; SDK capability alone is not a tested end-to-end login promise for every provider. macOS credentials use `@napi-rs/keyring`; native Keychain acceptance remains separate from injected-store tests.

Our OAuth adapter and service must:

- Use SDK protected-resource and authorization-server discovery while enforcing our URL/resource/issuer policy. Respect an explicitly configured issuer and never reuse credentials across issuers.
- Verify SDK PKCE S256, state, redirect, authorization-response issuer, and resource binding through owned auth-boundary tests. Do not duplicate the SDK's OAuth schemas or algorithms.
- Own a scoped loopback callback listener for supported local browser login. A manual callback flow is a user-only command dialog and still validates the registered redirect, state, and issuer. No arbitrary callback listener or promise that every provider supports remote-terminal login.
- Serialize credential refresh and atomically publish tokens. Refresh before dispatch when possible. A rejected dispatched operation returns `AuthRequired`; it is not silently replayed. Scope step-up requires a new explicit user auth command.
- Use an OS-backed credential-store adapter with no plaintext or session-only OAuth fallback in v1. The integration milestone records the tested OS/store combinations. If the store is unavailable, OAuth login and token refresh are unavailable; no-auth and environment-auth servers remain usable.
- Redact auth-related values before errors, logs, spans, notifications, or snapshots receive them.

Keep explicit-user SDK authentication separate from request transport authentication. The transport gets a token-only provider without automatic unauthorized recovery, uses `onInsufficientScope: "throw"`, and does not automatically fulfill server input requests. Verify the pinned API and prove that it cannot open login UI or replay a dispatched call. SDK retry defaults are not our application policy.

Login/logout run through the connection owner's auth fence, which blocks racing dispatch rather than leaving a gap between connection revocation and credential mutation. Logout revokes local auth-flow/refresh authority, closes the server connection, evicts its retained results, and removes local credential records. It does not promise provider-side token revocation. Report a failed store deletion rather than claiming logout removed the grant.

Only send access tokens to their intended resource, in the authorization header, never URL query parameters. Do not forward authorization across redirects. Bound discovery redirects and validate each target; deny discovered private/link-local endpoints unless covered by explicit trusted configuration. Use HTTPS for remote metadata/authorization/token endpoints and allow local HTTP only for explicitly configured local servers and registered loopback callbacks.

OAuth HTTP uses core's bounded `NetworkAddresses` resolver and `pinnedNetworkLookup` on the scoped HTTP agent. MCP policy validates the candidate set and each permitted discovery redirect; connection establishment uses only that set, not a second DNS answer. Core owns the generic DNS/listener boundaries, not OAuth policy. The local callback uses core's `nodeHttpServerLayer` inside the auth attempt. MCP owns its IPv4 bind policy, route/Host/origin checks, one-use state, issuer validation, and deadline. Manual mode requires a configured fixed-port `http://127.0.0.1` redirect and uses a user-only dialog without a local listener.

Remote HTTP servers can demand URL elicitation as part of a workflow. That is not ordinary OAuth support. Return a clear unsupported-capability error rather than pretending option 2 covers those interactions.

## Validation, results, and limits

Effect Schema decodes our config, public capability input, and normalized application results. The SDK validates its own wire protocol with its own schemas. Do not duplicate those wire schemas in Effect or author Zod schemas to call the SDK. Remote tool input/output JSON Schemas remain external data: permit local-document references only, no network/filesystem resolution, executable custom keywords/formats, coercion, default insertion, or argument removal. Refuse unsupported constraints rather than silently weakening validation.

The SDK's high-level tool path can synchronously compile remote output schemas and throw after receiving invalid structured output. Its validator hook is synchronous, so an asynchronous helper cannot simply replace it. The first milestone must prove a supported integration using the public request path and SDK-exported schemas, with owned isolated input/output validation, or an equally bounded supported arrangement. Check discovery paths too. Do not install a permissive validator and call that validation, fork SDK internals, or lose the completed result when validation fails.

Schema byte/node limits and an Effect timeout cannot bound synchronous validator CPU. Any required isolated validator runs fixed packaged code with bounded input/output, a deadline, and confirmed cleanup. Pathological regex/reference fixtures must prove that SDK integration cannot hang Pi. No model-supplied code, module names, or arbitrary helper executable is accepted. Validate arguments before dispatch and declared structured output after settlement. Remote annotations remain hints, not authorization or retry guarantees.

Normalized outcomes distinguish `not-sent`, `completed`, and `unknown`. A completed tool result preserves `isError`, typed content blocks, and optional `structuredContent`. Tool-reported failure is distinct from invalid arguments, protocol errors, transport failure, missing auth, cancellation, timeout, and output limits. An accepted result that fails output validation or projection is still completed, not an invitation to repeat the operation. Keep unknown errors out of public service error channels.

Top-level Pi execution must reflect tool-reported failures as actual Pi tool errors while retaining bounded result details. Prove this in the SDK integration milestone; returning an object with an `isError` property is not sufficient by itself. Code Mode receives the completed result's explicit `isError` flag. Client/transport failures become bounded catchable failures carrying operation identity and execution certainty.

Preserve content types. Text and JSON remain readable. Bounded PNG, JPEG, GIF, and WebP images can use Pi's normal top-level image results after base64, MIME, header/container, and declared-dimension checks. These checks do not fully decompress images or validate every frame. Audio and other binary content become explicit attachment metadata or unsupported-content notices, never opaque base64 in the model prompt. Code Mode always receives bounded JSON attachment descriptors/references, including for images, not native Pi attachments or raw base64. Resource links are not automatically followed.

Retain oversized but accepted results before projecting them to the caller's allowance. Use a private, bounded session result store with oldest-settled-result eviction. Return a result ID and explicit truncation/omission metadata. If retention fails, report completed-but-output-limited without claiming recoverability. No unlimited temporary-file spill, persistent archive, or raw server payload in tool `details`.

Bind each result to its session activation, server/config revision, original operation, execution certainty, and original tool `isError`. Recheck authorization on every `result.read`. Disconnect alone preserves completed results; disable, reconfigure, trust loss, logout, eviction, and session replacement revoke them. Retrieval has its own success/failure outcome and never changes the originating operation's status.

Implemented defaults and fixed limits:

| Limit                               | Default                                             |
| ----------------------------------- | --------------------------------------------------- |
| Connection / request deadline       | 15 seconds / 60 seconds                             |
| Idle disconnect                     | 10 minutes                                          |
| Concurrent operations               | 8 per session, at most 4 per server                 |
| Queued operations                   | 64 per session                                      |
| Serialized invocation input         | 1 MiB, with structural depth limits                 |
| Transport message / accepted result | 8 MiB, checked before unbounded parsing or decoding |
| Inline gateway text                 | 50 KiB or 2,000 lines, whichever comes first        |
| Discovery page                      | 20 entries, caller limit at most 100                |
| Retained results                    | At most 32 results and 64 MiB per session           |

Configuration is capped at 1 MiB per document, 64 KiB per server entry, and 256 servers. Remote discovery is capped at 64 pages, 1,000 entries per metadata family, and 4 MiB per metadata snapshot. Result normalization accepts at most 128 attachment descriptors. Top-level projection emits at most 8 native images under a separate 8 MiB encoded-data allowance and a declared 40-million-pixel limit per image. Schema nodes, diagnostics, and structural depth also have fixed bounds. Oversized wire responses cannot be recovered merely by increasing the inline output limit. Report that distinction and never retry a potentially completed invocation to recover its output.

Code Mode's remaining output allowance can lower a result projection limit. The MCP producer must honor it before copying a large result; the consumer independently validates and charges the normalized JSON against its existing budgets.

## Code Mode integration

Code Mode uses its existing sequencing and `Promise.all` support, without interpreter changes for MCP batching.

The fixed leaf is `tools.mcp.request(input)`. Its closed action union reuses `status`, bounded tool discovery/description/calls, resource/template operations, prompt operations, and `result.read` from the gateway. Exclude explicit connect/disconnect/refresh, authentication, configuration writes, and arbitrary protocol methods. Lazy connection remains an internal dependency of a permitted request.

This lets a program retrieve a truncated result without another assistant turn and batch resource/prompt operations as well as tool calls. It adds no dynamic guest catalog or second scripting language. For example, `Promise.all(requests.map((request) => tools.mcp.request(request)))` batches already-formed requests under the existing Code Mode limits.

`pi-mcp` exports a versioned `./code-mode` protocol containing producer-owned input/output codecs and a narrow Promise capability. Follow the existing [Background Tasks protocol](../../packages/pi-background-task/src/code-mode/protocol.ts): exact stable session ID, exactly one current provider, current activation checks, call ID, AbortSignal, and output allowance. Re-query on every invocation. Missing, duplicate, disabled, or stale providers fail closed.

Dependency direction is `pi-code-mode -> pi-mcp/code-mode`. This must not auto-load the MCP extension or create another connection owner. `pi-mcp` does not import Code Mode's private runtime.

The top-level gateway and this capability invoke the same authorization, argument-validation, connection, execution, and result services. MCP-specific permissions cannot live only in a Pi `tool_call` hook: nested capability calls bypass per-call Pi middleware, approvals from unrelated extensions, registered overrides, and preview wrappers. Only the outer `code_mode` call follows the ordinary Pi middleware path. Document this explicitly.

Authentication remains a user-command workflow. There is no nested authentication tool or batching-specific connection manager. Discovery is a fixed request action, not arbitrary registered-tool access. All nested projections, including catchable failure text, count against Code Mode's cumulative output allowance.

## Package ownership

Use the repository layout proportionally; these are ownership groups, not a requirement to create every file immediately.

| Location                                       | Owner                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`, `application/`, `layer.ts` | Registration, one session runtime, replacement, shutdown, and composition.                                |
| `src/config/`                                  | Versioned schemas, resolution, provenance, and the single config store.                                   |
| `src/connection/`                              | Server registry, acquisition, refresh admission, request ownership, and cleanup state.                    |
| `src/client/`, `src/protocol.ts`               | Internal client contracts/errors and the public capability re-export, not a second wire client or parser. |
| `src/discovery/`                               | Metadata revisions, bounded pagination, search, and exact lookup.                                         |
| `src/invocation/`                              | Shared tool execution, argument policy, and completed-result handling.                                    |
| `src/resources/`, `src/prompts/`               | Resource/template operations and prompt retrieval.                                                        |
| `src/auth/`                                    | OAuth policy, refresh ownership, and credential lifecycle.                                                |
| `src/results/`                                 | Content normalization, quotas, retention, and retrieval.                                                  |
| `src/tools/`, `src/settings/`                  | Gateway and user-command contracts/controllers.                                                           |
| `src/code-mode/`                               | Producer-owned protocol codecs and capability contract.                                                   |
| `src/boundary/`                                | Named Pi, SDK client/transport/auth, validation, credential-store, and browser-login adapters.            |

Keep MCP-specific services out of Cosmic Core. Use the SDK's public client, transports, and auth helpers behind package boundaries. Only demonstrated generic platform gaps belong in core; preserve its existing exports and do not add another runtime helper in `pi-mcp`. Any isolation helper justified by the SDK integration milestone must be fixed packaged code, not an extension scripting feature.

Wrap our previewable gateway output with `withCodePreviewShell`, after loading trusted preview settings in `session_start`. Declare `pi-code-previews` as a runtime dependency. Reuse Cosmic UI's terminal components where useful; there is no browser-app UI in this package.

## Delivery milestones

1. **SDK integration.** Pin the official SDK, implement narrow Effect adapters, and prove lifecycle/cleanup, validation isolation, no automatic replay/auth UI, byte limits, and Pi failure-result delivery. Record the tested negotiation/server and OAuth registration/OS/store/callback matrix. Do not build a custom MCP client.
2. **Config and connection lifecycle.** Add the package, trusted versioned config, one session runtime, lazy connections, bounded admission, status, and confirmed cleanup. Prove replacement and failed-start recovery before adding user-facing breadth.
3. **Gateway tools and results.** Implement discovery, exact description/call, filters, isolated schema validation, typed failure mapping, bounded result retention/retrieval, and cooperative rendering. Cover stdio and HTTP with no-auth and environment-auth fixtures.
4. **OAuth.** Integrate SDK public-client auth and supported registration paths with our metadata policy, user-only login/callback handling, secure storage, refresh, logout, and redaction. Do not count OAuth as shipped until interruption and stale-refresh tests pass.
5. **Resources and prompts.** Add paginated resource/template and prompt discovery, resource reads, and role-preserving prompt retrieval. Keep subscriptions, generated read tools, and slash-command installation out.
6. **Code Mode.** Publish the session capability and add the fixed `tools.mcp.request` consumer. Test tool/resource/prompt batching, discovery, retained-result retrieval, shared limits, revocation, and output accounting. Update Code Mode's complete tool description and architecture document.
7. **Release readiness.** Add argument-first commands, setup examples, supported-mode/version/OS/auth documentation, package architecture, packed-source checks, and the complete validation gate. A custom picker is optional. No publishing or release actions are part of this task.

All seven milestones are complete. The acceptance checks below passed. No publishing, release actions, or changes to the user's installed Pi configuration were performed.

## Acceptance record

- [x] Gateway, config/connections, invocation/results, OAuth/Keychain adapter, resources/prompts, user commands, and fixed Code Mode capability implemented.
- [x] Real filesystem and Playwright compatibility smoke passed on macOS through `McpExecution`, not a separate SDK-only client.
- [x] Smoke cleanup verified for owned processes, temporary installation, browser, profile, and fixtures.
- [x] Final focused integration checks after bounded config-read/write and auth-fence repairs: 315 MCP, 248 core, and 138 Code Mode tests passed.
- [x] Pinned public Pi agent-loop proof preserves the actual error flag, content, details, and retained result ID.
- [x] Native macOS Keychain acceptance passed: missing read, create, read, replace, read, delete, and confirmed absence in one disposable UUID namespace. No existing records were inspected.
- [x] Final workspace `pnpm validate`, including version, layout, diagnostic, TypeScript, lint, format, test, and packed-source installation checks.
- [x] Final `pnpm mcp:smoke` rerun passed with both real servers and confirmed cleanup.

| Real server                               | Version     | Protocol     | Evidence                                                                                            |
| ----------------------------------------- | ----------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server-filesystem` | `2026.8.31` | `2025-11-25` | 14 tools; read/write; input/output validation; 80 KB result retained and recovered in bounded pages |
| `@playwright/mcp`                         | `0.0.80`    | `2025-11-25` | 24 tools; isolated local-page navigation, snapshot, evaluation, and browser close                   |

The browser run used Playwright manifest `1.63.0-alpha-2026-08-31`, Chromium `153.0.8010.12`, revision `1243`. `pnpm mcp:smoke` runs `node scripts/verify-mcp-compat.mjs`, installs pinned packages and the browser into owned temporary storage, and verifies cleanup. It requires network access and macOS, not third-party account credentials. Owned HTTP/OAuth fixtures remain the evidence for transport/auth behavior; no live-provider or modern-negotiation certification is implied.

## Acceptance and verification

Tests protect owned behavior, not snapshots of external SDK payloads or UI copy.

- Untrusted sessions cause no project-document I/O, credential resolution, server launch, or network admission.
- Invalid project overrides, disabled servers, changed targets, and denied tools cannot gain inherited credentials or stale access.
- Concurrent calls share one logical connection. Cancelling one request releases its application/SDK request ownership without aborting unrelated calls, and late settlement cannot publish. Queue overflow, disconnect, process exit, probe-process cleanup, and repeated shutdown settle without leaking ownership.
- A lost tool response is not replayed. Recovery distinguishes a future explicit call from retrying an uncertain mutation. Deadlines cover queued work as well as remote execution.
- Paginated metadata publishes atomically; absent versus empty cursors, loops, changed lists, and stale snapshot cursors are handled explicitly.
- Validator fixtures cannot fetch external references, mutate arguments, or indefinitely block Pi through pathological schemas. Failed helper cleanup blocks unsafe reuse.
- Tool failures, malformed results, unsupported content, truncation, retention failure, revoked result IDs, and quotas remain observable through both entry points. Reading a result page preserves the original failure and execution status.
- Resource URIs never gain local filesystem or arbitrary HTTP authority; prompt retrieval never sends a new user message.
- OAuth rejects bad state, issuer/resource mismatch, unsafe redirects, and stale refresh publication. Unavailable stores and failed local logout have explicit outcomes. Tokens never reach diagnostics or model results.
- Unsupported Apps, elicitation, sampling, registration methods, and protocol revisions fail clearly without opening UI or calling a model.
- Code Mode cannot use an absent, ambiguous, inactive, or replacement-session provider. Batches can retrieve retained results and obey MCP policy even though nested Pi middleware does not run.
- The package and any required fixed helper load from a packed source install with normal SDK dependencies, without workspace-generated `dist/`, the installed reference extension, or an active Code Mode extension.

Use owned domain boundaries for unit tests, TestClock/Deferred for lifecycle races, and small owned local MCP fixtures for protocol/transport interoperability. Test commands should never depend on a live third-party account.

The agreed real-server smoke tests use pinned versions of `@modelcontextprotocol/server-filesystem` and `@playwright/mcp` on macOS. Limit filesystem access to a temporary fixture directory. Give Playwright a fresh isolated browser profile and a local fixture page, never the user's existing browser session. Owned HTTP/OAuth fixtures cover remote transport and login behavior without third-party credentials. This baseline does not claim compatibility with every deployed server or OAuth provider.

During implementation, run the narrow package tests first, then Code Mode's suite when its adapter changes, then the full workspace gate:

```bash
pnpm --filter pi-mcp test
pnpm --filter pi-code-mode test
pnpm mcp:smoke
pnpm validate
```

A documentation-only change to this plan needs formatting/link checks, not a claim that runtime tests passed.

## Explicitly deferred

MCP Apps and any browser/webview host; elicitation and sampling; automatic OAuth during model calls; operating a public client-metadata endpoint and confidential-client OAuth; individual or per-server tool registration; `mcpScript`; config importers; package/host config discovery; command-derived secrets; legacy HTTP+SSE fallback; Unix sockets; protocol behavior outside the pinned SDK's tested negotiation modes; resource subscriptions; tasks, roots, argument completion, and logging-control APIs; persistent metadata caches; cross-session connection sharing; and a standalone CLI/SDK product.

## Protocol references

- [Official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). The published SDK and its tested public interfaces implement the protocol; these specifications define the compatibility checks, not a second client to build.
- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts), and [pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination).
- [2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), documenting the newer wire model supported through the SDK's explicit modern-negotiation mode, subject to the integration tests above.
