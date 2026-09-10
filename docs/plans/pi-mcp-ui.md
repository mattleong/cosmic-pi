# pi-mcp UI upgrade

Status: implemented. The user authorized all six phases. Authentication policy and user-only login authority remain unchanged. See the [implementation record](#implementation-record) for verification.

The selected ideas are 1 through 8, plus 10, 11, and 12. Idea 9, a settings form, is excluded. The existing [MCP implementation plan](./pi-mcp.md), [package architecture](../../packages/pi-mcp/ARCHITECTURE.md), [Effect architecture](../architecture/effect-v4.md), [Pi boundaries](../architecture/pi-boundaries.md), and [testing policy](../architecture/testing.md) remain the baseline.

## Scope and defaults

| Selected idea                 | Planned behavior                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1. Sign-in panel              | Real phases, elapsed time, current deadline when available, and exact-attempt cancellation.                                        |
| 2. Actionable errors          | Fixed reasons, safe explanations, and valid recovery actions instead of raw JSON notifications.                                    |
| 3. Honest auth states         | Separate unchecked credentials, required authentication, locally verified credentials, unavailable storage, and no authentication. |
| 4. Browser handoff            | Reopen the validated URL for the same active attempt without restarting registration or extending its deadline.                    |
| 5. Completion feedback        | A static browser acknowledgment, followed by success in Pi only after the complete auth operation settles.                         |
| 6. Server dashboard           | A passive server list with connection/auth state, scope, transport, permitted cached counts, and blocked reasons.                  |
| 7. Context-sensitive actions  | Inspect, sign in, connect, discover/refresh metadata, disconnect, and log out through existing service authority.                  |
| 8. Compact tool cards         | Readable call/result summaries, expandable existing details, and explicit access to retained output.                               |
| 10. Capability browser        | Search cached tools, resources, templates, and prompts without invoking them.                                                      |
| 11. Quiet persistent status   | One updating row per real long-running operation, retained safe failure details, and a compact MCP status contribution.            |
| 12. Shared interaction design | Cosmic UI navigation, responsive list/detail layouts, semantic styling, and configured key hints.                                  |

Recommended defaults:

- Bare `/mcp` opens the dashboard in TUI only. Explicit `/mcp status` and existing machine behavior remain available.
- Enter opens details, never a changing or destructive primary action. A separate action menu shows available operations and disabled reasons.
- One interactive login presentation is active per session. A repeat request focuses that attempt or reports it; it never queues another browser launch.
- Escape or Cancel stops the exact login attempt. There is no implicit background continuation when its panel closes.
- Cancellation does not log out, delete credentials, or claim provider-side revocation.
- Successful sign-in offers a separate Connect action. Authentication and connection state stay distinct.
- Capability browsing is metadata-only. Tool invocation forms, resource reading, prompt retrieval, and settings forms are not part of this upgrade.
- Retained output is opened by result ID. A new result-history index is not required.

## User experience

### Sign-in

`/mcp auth ID` and the dashboard Sign in action use the same flow. Before starting a nested dialog, release the MCP dashboard's overlay and retain only its safe selection state. Return to a fresh dashboard after auth settles when the action originated there.

The panel shows the configured server ID, one current phase, elapsed time, an explanation of any user action needed, and available actions. For example:

```text
Sign in to Atlassian

Waiting for browser approval
Elapsed 0:28

Reopen browser     Cancel sign-in
```

Phases come from actual operation boundaries:

1. Waiting for the auth fence and prior connection cleanup.
2. Checking secure storage.
3. Preparing the callback listener, for local mode.
4. Discovering resource and authorization-server metadata.
5. Preparing or registering the public client.
6. Opening the browser and waiting for its callback.
7. Validating the callback and exchanging the authorization code.
8. Saving credentials and finalizing the connection fence.
9. Succeeded, failed, cancelling, or cancelled.

Do not show fabricated percentages or imply a conditional phase ran when it was skipped. Use `Clock` timestamps. Show remaining time only for a deadline actually enforced by the owner. The current 180-second SDK budget, 300-second manual dialog request, and separate storage waits are not one total deadline. Derive dialog timeouts from the remaining applicable budget rather than displaying a misleading total countdown.

A browser-open failure leaves an explicit recovery action for the same valid attempt where possible. Reopening must not repeat discovery, registration, PKCE creation, listener acquisition, code exchange, or credential writes. Revoke the action when the callback is consumed, the deadline passes, cancellation begins, or authority changes.

Manual mode still requires a configured fixed-port IPv4 loopback redirect and does not start a listener. Never silently switch between local and manual modes.

The browser callback page becomes a small static acknowledgment: "Sign-in response received. Return to Pi to finish." It must not report successful authentication before validation, exchange, persistence, and outer finalization complete. Preserve restrictive CSP and no-store behavior; add a no-referrer policy. No reflected callback values, scripts, external assets, analytics, or polling.

### Auth evidence and errors

Introduce an `unchecked` credential state while retaining `none`, `required`, `ready`, and `unavailable`:

- `unchecked`: no credential check in this activation. Opening status does not perform one.
- `required`: an observed missing/rejected credential or explicit logout.
- `ready`: the latest applicable credential check or completed login succeeded. This is not proof of a live connection or remote health.
- `unavailable`: storage or authentication could not be checked. Do not relabel this as signed out.
- `none`: no managed authentication is configured.

For environment authentication, render ready as "Credential available," not "Signed in." For OAuth, successful sign-in means the full login operation completed and credentials were saved. Invalidate stale evidence on target/config changes and current-owner authentication rejection. Map only auth-specific transport evidence; do not reinterpret an ordinary remote tool permission error as expired credentials.

Extend the existing fixed diagnostic reasons with storage unavailable, unresolved credential mutation, browser-open failure, callback timeout, unsupported registration, rejected binding, failed deletion, and finalization failure. A pure mapping chooses explanation, severity, and safe next steps. Never inspect SDK error strings to choose recovery.

Keep both protected-resource discovery reasons. Missing metadata may explain the explicit issuer-bound compatibility option; malformed metadata must not offer compatibility as a bypass. No UI action silently changes `allowMissingResourceMetadata` or another configuration value.

### Dashboard and server actions

The dashboard uses a searchable server list and a detail pane. Wide terminals show both; narrow terminals show one pane at a time. Preserve selection by exact server ID after filtering and updates.

Rows show configured ID, global/project scope, transport, enabled/invalid state, observed connection/auth state, and permitted cached metadata counts. Show aggregate active/queued work in the header. Add per-server counts only from authoritative admission state, not inference from displayed cards. Use explicit blocked reasons for auth suspension versus unconfirmed cleanup.

Do not include command arguments, environment/header bindings, credential identities, raw config contents, or raw provider diagnostics in shared dashboard snapshots.

| Server condition                | Action behavior                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Valid, enabled, disconnected    | Connect; Discover metadata; inspect the cached browser, including an undiscovered state.       |
| Connected                       | Browse cached metadata; Refresh metadata; Disconnect.                                          |
| Connecting                      | Inspect progress; offer the existing disconnect/cancel-connection operation when permitted.    |
| OAuth authentication required   | Sign in; inspect safe diagnostic context. No automatic login from Connect.                     |
| Credentials unchecked           | Explain that the next explicit connection checks credentials; do not claim sign-in is missing. |
| Disabled, invalid, or untrusted | Explain the restriction. No execution or credential actions.                                   |
| Cleanup unresolved              | Explain that access is blocked. Do not offer an apparently safe reconnect.                     |

Confirm disconnect when it affects active work. Confirm logout and explain local credential deletion, connection/result revocation, and the absence of provider-side token revocation. An unchecked credential state is not evidence that no stored grant exists, so explicit logout must not rely solely on the displayed ready state.

Capture server identity, config revision, operation revision, and allowed action when opening a confirmation. Recheck after confirmation, before dispatch, and before publication. Reject a stale action instead of applying it to a replacement target with the same name.

### Capability browser

Provide Tools, Resources, Templates, and Prompts tabs, with a server filter and local search. Optional `/mcp browse [ID]` opens the same TUI browser directly. Non-TUI calls return a bounded unsupported-UI explanation without discovery; existing gateway discovery remains the machine path.

Search all permitted cached entries in the selected scope, not just the visible page. Detail sections show bounded names, descriptions, argument/schema metadata, and family support. Keep exact remote identifiers separate from sanitized or shortened display labels.

Opening, searching, selecting, expanding, and changing tabs must not connect, refresh, invoke a tool, read a resource, retrieve a prompt, install a prompt, follow a link, fetch an icon, or resolve a schema reference. Discovery is a separate explicit action labeled to explain that it may connect.

Distinguish undiscovered, unsupported family, empty catalog, refreshing, refresh failed, and invalidated cache. A failed refresh may leave the last complete revision visible only while its owning authority remains valid. Disconnect, owner expiry, auth revocation, trust loss, reconfiguration, and session replacement withdraw affected cached content. Do not preserve a second UI cache after service revocation.

### Tool cards and retained output

Add custom call/result renderers to the owned `mcp` tool, keeping `withCodePreviewShell` responsible for framing and preview settings.

Collapsed cards show the operation and server/target, success or failure, useful counts, truncation/attachment information, and recovery availability. Unknown-outcome and cleanup warnings remain visible when collapsed. Expanded cards show bounded existing details, notices, and origin information. Expansion is display-only.

Preserve serialized content, reply details, images, retained IDs, execution certainty, and owned error-receipt identity. The pretty renderer must not replace the model-facing JSON envelope. Handle partial arguments, missing/legacy details, and hostile terminal controls safely. Never fabricate a completed or not-sent reply to represent running UI.

If duration is shown, measure it at the existing host execution boundary and keep it in bounded session-local presentation records keyed by activation and call ID. Do not infer it from first render time or add undeclared top-level fields to the Code Mode envelope. Historical or evicted timing is simply omitted.

`/mcp result ID` opens a TUI retained-output viewer through the existing authorized local result-read path. Keep a bounded page cache and previous-offset stack, using returned `next` offsets. Preserve the originating outcome and failure even if retrieval itself succeeds. On eviction or revocation, show unavailable; never rerun the original operation. No result-history index or new persistence store is needed.

### Persistent status and shared interaction

Use one keyed MCP footer/status contribution for connected, active, queued, and needs-attention counts. Hide it when entirely inactive and non-actionable. It must not replace Cosmic UI's footer or Pi's working indicator.

Use Activity v1 `kind: "command"` rows for actual auth, connection, and metadata-refresh operations. Update one stable row through its phases. Browser approval may be `needs-input` with `inputTarget: "user"`; cleanup is `stopping`, not premature cancellation. Idle connected servers are not permanently running tasks.

Do not duplicate every tool call or protocol packet into Activity. Tool cards cover ordinary invocations. Shared connection/discovery work has one activity owner even when several calls, including Code Mode calls, wait for it. Publish from shared service ownership, not only the visible tool wrapper.

Activity actions open the MCP-owned detail/auth panel rather than exposing a login capability or authorization URL on the event bus. Require an explicit user action in that panel for new authentication. Retain bounded safe failure information for inspection, not raw responses or a second copy of retained output.

Reuse Cosmic UI's list/detail shell, searchable selection, shared navigation, configured key hints, status styling, and ref-counted repaint helpers. Respect normal text entry while searching and IME focus. Use text labels as well as color for important state. Preserve selection and scroll position across updates; discard revoked content. No network or credential work runs from a renderer or repaint ticker.

## Ownership and compatibility

Keep current service authority:

- `auth/service.ts`: credential access, refresh, revocation, and observed auth evidence.
- `connection/`: admission, connection ownership, auth fence, and cleanup certainty.
- `discovery/`: the only metadata store, filtered cached reads, revisions, and invalidation.
- `results/`: retained output, limits, result identity, and authorized retrieval.
- `config/store.ts`: the only config persistence entrypoint. No new settings store.

Add small MCP-owned presentation services:

- `auth/flow.ts` and `auth/progress.ts`: one explicit-user attempt around the existing `McpExecution.login`, scoped worker ownership, safe immutable progress, and private attempt actions. SDK/store phase observers feed this owner; they are not a second auth authority.
- `manager/model.ts`, `policy.ts`, `service.ts`, and `controller.ts`: safe view schemas, available actions, manager admission, coalesced updates, and user-command coordination. The manager owns presentation state, not duplicate grants, connections, metadata, or results.
- `client/diagnostics.ts`: fixed reason-to-explanation/recovery projection shared by auth and command UI.
- `boundary/host-ui.ts`, `host-auth-panel.ts`, and status/activity adapters as needed: guarded Pi calls, ownership-safe mount/close, user-only browser handoff, and protocol publication.
- Top-level `ui/`: pure dashboard, browser, auth-panel, result-view, and tool-card rendering. Split components by role instead of creating a large controller/rendering file.

`application/lifecycle.ts` remains the sole session runtime submission boundary. Compose new services in `layer.ts`; register inert commands/events at startup. Add `pi-cosmic-ui` as a runtime dependency and declare Pi TUI dependencies consistently with sibling packages. Keep source-only loading and the existing preview wrapper.

Add an internal cached-only discovery read API. Existing targeted discovery calls can connect. Dashboard aggregation must read service snapshots directly: gateway `execute(status)` retains output, so polling it would consume the 32-result store. Coalesce local invalidations through a scoped worker. Callbacks invoked under registry locks may only enqueue invalidation or publish bounded local data; they must not reenter connection services.

Async view requests carry activation, opening owner, trust/config revision, exact server identity, applicable metadata revision, and request generation. Reject old search/detail results after selection changes. Withdrawing authority must clear affected visible content, not merely suppress the next refresh.

The gateway and Code Mode request unions remain unchanged: no login, callback, reopen-browser, user confirmation, or UI actions. Prefer internal presentation fields. Document the new observational auth value wherever status exposes it. Preserve `/mcp status` as the explicit structured command, while action commands get readable TUI completion/error presentation. `/mcp-settings` remains argument-first, without a form.

## Privacy, cancellation, and host modes

Authorization URLs, callback URLs, codes, state, PKCE material, tokens, credential identities, and raw auth errors never enter tool replies, retained output, command messages, Activity, footer/status data, telemetry, or progress snapshots. Terminal sanitization is not sufficient protection; sensitive values must never enter those projections.

The current manual auth dialog embeds the authorization URL in its title. Pi publishes prompt titles through `ui_prompt_start`, so fix that before adding activity integration. Use a fixed nonsecret title and an explicitly user-only URL display field. Prove that the selected stock RPC UI path keeps URL/input out of prompt lifecycle events and MCP publications. Do not invent a new RPC protocol or fall back to transcript/editor injection.

| Mode       | Behavior                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI        | Full dashboard, auth panel, capability browser, cards, result viewer, and status/activity presentation.                                                                                            |
| RPC        | Preserve structured command replies and supported stock user dialogs. No `custom()` calls. Use sanitized status updates and sequence private URL display/callback entry without competing prompts. |
| Print/JSON | Preserve noninteractive commands and existing-grant verification. Never open a listener, browser, or auth dialog.                                                                                  |

Adopt the pinned Pi ownership-safe overlay pattern from Cosmic UI's host activity adapter. `onHandle` acknowledgment, owned handle removal, and guarded completion must protect unrelated newer overlays. Test late factory invocation and pre-mount cancellation. Shared manager chrome does not provide resource cleanup.

Cancel revokes browser/callback action authority, publishes cancelling, interrupts the exact attempt, and joins its Effect plus owned listener/overlay cleanup. It must not globally revoke unrelated server auth or call logout as a shortcut. Native Keychain mutation may outlive an interrupted waiter behind the existing process-wide fence. Do not wait indefinitely for that native Promise or claim credentials were removed. Expose a bounded local mutation state without reading Keychain; show unresolved save/access blocking honestly.

Publish terminal success only after the outer auth fence returns successfully. A saved grant followed by failed finalization needs a partial-success explanation, not a green signed-in completion. Recovery may start a fresh explicit login only when admission permits it. Reopening the browser never starts a new login. Unknown/completed remote operations never get automatic replay or a misleading generic Retry action.

## Implementation phases

### Phase 1: safe contracts and readable outcomes

- Define auth evidence, fixed diagnostic reasons/recovery rules, progress events, and safe manager projections.
- Add `unchecked` status without credential I/O. Preserve observed auth rejection and config invalidation semantics.
- Define pure server action policy and typed blocked reasons.
- Replace action-command JSON notifications in TUI with readable outcomes, preserving structured status and machine paths.
- Verify the private RPC handoff and overlay ownership approach before building the auth panel.

Done when initial status is honest, each failure has a safe explanation, and machine replies remain compatible. This is a useful first change even before the manager exists.

### Phase 2: complete auth workflow

- Add attempt ownership and real progress reporting through the current login/fence path.
- Build the cancellable panel and same-attempt browser reopen action.
- Align displayed/actual deadlines, isolate manual handoff from public prompt titles, and improve the callback page.
- Publish success only after finalization; expose unresolved storage mutation truthfully.
- Add a minimal keyed status fallback while the attempt is active or needs attention.

Done when local and manual user flows have correct progress, recovery, cancellation, privacy, and terminal outcomes. No automatic connection after login.

### Phase 3: dashboard and server actions

- Add the session-owned manager, local subscriptions, safe aggregate reads, and ownership-safe host UI.
- Route bare TUI `/mcp` to the dashboard; keep explicit and non-TUI commands.
- Add action selection, confirmations, blocked reasons, and return-to-dashboard after auth.
- Add command/server-ID completion from existing safe state only.

Done when opening/repainting is passive, confirmations cannot target changed servers, and closing MCP never closes an unrelated overlay.

### Phase 4: capability browser

- Add bounded cached-only discovery queries with revision evidence.
- Build family tabs, server filtering, local search, and bounded metadata details on the manager shell.
- Add explicit Discover/Refresh actions and distinct empty/unsupported/invalidated states.

Done when browsing never invokes remote work and revoked data disappears immediately.

### Phase 5: tool cards and retained-output inspection

- Add pure call/result renderers and defensive detail normalization under the existing preview shell.
- Preserve compact unknown/cleanup/truncation warnings and accurate origin outcomes.
- Add the explicit retained-result viewer and bounded cursor navigation; measure duration only at execution boundaries.

Done when rendering and expansion perform no I/O, machine payloads/error receipts remain unchanged, and output recovery never replays an operation.

### Phase 6: shared status, Activity, and interaction pass

- Complete the aggregate footer/status contribution and actual-operation Activity rows.
- Preserve fallback status until Cosmic UI acknowledges ownership; clear only the old session's contributions on replacement.
- Remove transition toast churn; keep bounded failure inspection and one terminal completion per user action.
- Check shared navigation, search/IME behavior, narrow layouts, theme invalidation, and scoped repaint lifetimes across every screen.

Done when real work updates in place, idle connections remain quiet, and no new footer or generic navigation framework exists.

After Phase 1 contracts settle, the auth workflow and pure tool-card rendering can be implemented independently. The retained-output viewer still depends on Phase 3's manager. Phase 4 depends on the manager and cached-read authority, not just a visual tab component. Phase 6 integrates existing operation owners rather than adding another task scheduler.

## Verification and completion criteria

Tests protect behavior rather than exact UI copy, colors, key-hint strings, ANSI output, or layout snapshots. Use owned boundaries and `Deferred`/`TestClock` for lifecycle races.

Required coverage:

- Repeated status/dashboard/browse opening performs no credential reads, environment resolution, remote discovery, connection, project-config I/O while untrusted, or retained-result allocation/eviction.
- Auth transitions reflect actual phases and outer settlement. No stale observer or delayed write produces false success after cancellation, logout, reconfiguration, or replacement.
- Cancellation before mount, during browser wait/exchange/save, and during final fence checks preserves cleanup and Keychain mutation certainty.
- Reopen operates on the same attempt without another registration, listener, exchange, or deadline; expired/consumed/replaced actions fail closed.
- Recognizable secret fixtures are absent from all public UI events, titles, status/activity snapshots, errors, tool replies, retained output, and telemetry.
- Cached search covers the selected catalog, preserves exact identity, respects tool policy, rejects stale cursors, and withdraws revoked data.
- Confirmation/selection races cannot apply an action to a changed target. Permission errors stay distinct from auth evidence.
- Partial/legacy/malformed tool details and terminal-control input have bounded safe fallbacks. Rendering preserves actual outcomes, images, error receipts, and original failures under successful result retrieval.
- Result pagination handles Unicode, returned offsets, eviction, and revocation without retrying the source operation.
- TUI overlay ownership, RPC dialog sequencing, headless restrictions, subscriptions, and repaint cleanup hold across replacement and shutdown.
- Code Mode uses the same service observations without gaining user-only actions or breaking its closed output envelope.

Run narrow MCP tests, typecheck, Effect diagnostics, and formatting first. Run relevant Code Mode and Cosmic UI checks as their integration changes, then `pnpm validate`. Manually exercise local/manual auth, browser launch failure, cancellation, narrow terminals, search, partial results, and an unrelated questionnaire opening above MCP.

The pre-implementation `pnpm validate` baseline failed in unchanged `pi-cosmic-core` typecheck diagnostics. The previously failing `pi-subagents` process-transport suite passed when rerun before these edits. No checks were disabled and no unrelated package was changed to hide a failure.

Update package README/ARCHITECTURE and architecture boundary documentation alongside ownership changes. No publishing, version change, generated runtime output, credential migration, or modification of user auth configuration is part of this UI plan.

## Implementation record

All six phases are implemented in `packages/pi-mcp`. The package now depends on the source-loaded Cosmic UI package and declares Pi TUI consistently with sibling extensions.

- Auth evidence, diagnostic mapping, exact-attempt progress/cancellation, same-URL reopening, private RPC handoff, and outer-fence completion are covered by owned fixtures. Native browser settlement has its own nonqueuing guard. Generic HTTP 403 denial stays separate from authentication rejection.
- The TUI dashboard and actions use passive snapshots and exact displayed-target admission. Cached browsing searches complete permitted catalogs, keeps refresh/failure state visible beside retained entries, and withdraws revoked metadata.
- Tool cards preserve execution envelopes, images, error receipts, and original failures. The result viewer uses returned offsets and immediate result-store invalidation. Unrelated work does not discard expansion or scroll position; restoring text requires authorized local reads.
- Shared operation owners publish bounded Activity rows and a keyed status contribution. Cancellation cannot be dropped behind browser opening, and late terminal failures survive retention limits.
- README, ARCHITECTURE, and Pi boundary documentation describe the new ownership. No user configuration or credentials changed during this UI work.

Verification:

- `pnpm --filter pi-mcp check`: passed.
- `PI_MCP_KEYCHAIN_INTEGRATION=0 pnpm --filter pi-mcp test`: 443 tests passed across 43 files.
- `pnpm --filter pi-mcp effect:diagnostics`: 0 errors, 0 warnings; informational messages remain.
- Shared Cosmic UI and Code Mode test suites passed.
- Independent auth, manager/authority, and card/status reviews found five edge cases. Each has a regression test and a passing fix.
- A source-loaded component smoke passed 60 width/height combinations across dashboard, browser, and result views, including nonempty failed-refresh catalogs. Widths were 4, 20, 40, 80, and 120 columns; heights were 3, 4, 12, and 30 rows. Owned host fixtures exercised RPC sequencing, browser failure, cancellation, late mounts, and newer unrelated overlays. No real account sign-in or native Keychain mutation was performed.

- `pnpm lint`, `pnpm format:check`, `git diff --check`, and 15 relative documentation links passed. Version, layout, and disabled-diagnostic guards also passed.
- `pnpm pack:smoke` passed, including clean-consumer TypeScript/Jiti imports and packed MCP execution. No build output or runtime prerequisite was added.
- `pnpm validate` still fails at the unchanged core typecheck baseline: `src/platform/json-document.ts:51`, `src/testing/layers.ts:139`, `tests/json-document.test.ts:23`, and `tests/process-runner.test.ts:180,182` under `packages/pi-cosmic-core`. These are Effect TS47/TS29 diagnostics; the command exits 2.
- Separate `pnpm test` passed the MCP and other package suites but failed the existing `packages/pi-subagents/tests/process-transport.test.ts:316` case, `captures early IPC, leaves parser overflow to the backend, and preserves Pi frame policy`. Its 5-second timeout also reproduced alone. Neither `pi-cosmic-core` nor `pi-subagents` has changes in this work. The full validation gate is not passing.

### Follow-up discovery diagnostics

An attempted Atlassian discovery exposed two error-reporting bugs. Ordinary SDK JSON-RPC errors fell through to `transport`, and completed failures directed users to an existing result even when no result had been retained. Offline reproduction confirmed both; it did not establish Atlassian's actual error.

The shared HTTP/stdio protocol mapper now preserves fixed reasons without exposing server messages, data, or custom codes. Completed diagnostics retain the safe cause and allow inspection only, without assuming retained output. Transport uncertainty, cleanup precedence, and the stdio initialization convention are unchanged.

Fifty-one additional regression cases cover standard/custom errors, missing-resource subclasses, bare unsupported codes, privacy, cleanup, no replay, and completed failures without result IDs. All 494 MCP tests and 138 Code Mode tests pass. Package checks, Effect diagnostics with zero errors/warnings, workspace lint/format, and packed-source smoke pass. `pnpm validate` still stops at the unchanged core diagnostics listed above. This follow-up did not retry Jira, authenticate, or change user configuration.

### Follow-up catalog compatibility

A subsequent scoped probe confirmed the capability mismatch. Atlassian advertised resources and returned 32 tools, but both resource listing methods returned `-32601`. The probe blocked auth mutations, printed no credentials, and confirmed its connection cleanup.

Discovery now tolerates only a first-page `completed/unsupported/rpc-method-not-found` response, independently for each advertised catalog. Successful full lists, support flags, and fixed diagnostics publish as one owner-bound revision. Other failures and later-page missing methods remain fatal. Internal query results bind notices to their metadata revision; the existing gateway envelope and retained-result rules are unchanged.

Twenty-six additional regressions cover independent families, recovery, invalidation, fatal and later-page failures, single-slot cold discovery/invocation, validation, and retained notices. All 520 MCP tests and 138 Code Mode tests pass. Package checks and Effect diagnostics pass with zero errors or warnings. After the user reloaded, the normal MCP gateway successfully discovered the Jira read tool and fetched the requested issue. No Jira write, login, logout, or endpoint/configuration change was performed. Workspace lint/format and packed-source smoke also pass. `pnpm validate` remains blocked by the same unchanged core typecheck diagnostics recorded above.
