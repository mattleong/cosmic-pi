# MCP feature follow-up and acceptance

Status: accepted. The authorized implementation, review corrections, package checks, combined workspace validation, and two existing pinned conformance scenarios passed. No known review findings remain. Changes are uncommitted; package versions remain `0.2.0`.

The [capability matrix](../../packages/pi-mcp/CAPABILITIES.md) records supported behavior and restrictions. This record does not expand the historical [original plan](./pi-mcp.md), [UI record](./pi-mcp-ui.md), or [modernization record](./pi-mcp-modernization.md), and is not protocol certification.

## Authorized scope

- Required modern-HTTP `x-mcp-header` filtering and bounded mirroring. Strings, integers, and booleans are allowed; `number` is invalid even where the SDK accepts it.
- Metadata `ttlMs` and `cacheScope`, active expiry, earliest page/family expiry, passive local browsing, and auth-context fencing.
- `completion.complete`, resource subscribe/unsubscribe and local inspection, `events.read`, and bounded progress/log presentation through the existing executor.
- Modern elicitation and multi-round-trip continuation through Ask User's separate owned local-extension form capability. No public answer or continuation-state API.
- Bounded credential-lock admission independent of native Keychain deadlines, normal exact-owned release cleanup, and offline recovery guidance.

Existing trust, enabled-server, and allow/deny controls remain authoritative. No permission-policy engine, implicit authentication, parallel executor, persistent metadata/event store, new automated cross-SDK server matrix, Python fixture, or CI job was added. Historical HTTP+SSE transport remains unsupported; SSE itself is not deprecated. Structured Logging is deprecated in `2026-07-28` and restricted to explicit modern-HTTP compatibility. Progress is not deprecated. Apps and tasks remain deferred, not deprecated. Roots and sampling are not added.

## Accepted implementation

| Workstream                  | Accepted behavior                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential coordination     | One monotonic admission budget across auth authority, local permits, filesystem polling, and post-acquisition checks. Admitted/native-pending ownership never expires. Normal exact-owned release artifacts are collectible. |
| Headers                     | Bounded annotation scan and invalid-tool exclusion; validated header derivation and encoding through the real HTTP adapter. Invalid UTF-16 fails before dispatch. Legacy/stdio behavior is preserved.                        |
| Metadata                    | Earliest bounded expiry, private scope by default, authorization-revision binding, active reacquisition, and local current-revision cursor continuation even after zero-TTL expiry.                                          |
| Completion and observations | Advertised reference/argument validation, bounded results, request-associated progress, HTTP-only opt-in logging, and local observation reads.                                                                               |
| Resource subscriptions      | Exact acknowledged filters, connection-owned leases, private generation checks through publication, native cleanup confirmation, and bounded lifetime retention. No automatic reads or re-listening.                         |
| Private interaction         | Current same-session owned forms and URL consent, strict schema mapping, bounded continuation, fresh authority before further UI/browser/dispatch work, and private answers/state.                                           |
| Native callback context     | Scoped core `makeNativeContext`, with revoked `run`/`current` after closure. Callback provenance grants no authority and introduces no foreign parser or Effect runner.                                                      |
| Documentation and packaging | Public action tables, architecture, recovery instructions, capability matrix, and published `CAPABILITIES.md`. Source-only Jiti loading remains intact.                                                                      |

## Bounds and recovery

Credential `acquireTimeoutMs` defaults to 15 seconds and accepts positive finite values up to 2,147,483,647 ms. It bounds admission only, including the post-acquisition authority check after exact-owner release is installed. Admitted transactions and native mutations are not timed by this budget. Local notifications wake waiters, without a FIFO or waiter-count guarantee. Synchronous filesystem stalls cannot be preempted.

The lock namespace is `.cosmic-pi-locks-v1` under the actual OS account home, independent of `HOME` and agent directory. Successful normal transactions best-effort delete validated exact-owned `.released-<token>` artifacts. Dead-recovery `.retired-<token>` barriers, old artifacts, crash candidates, and malformed/native-pending evidence remain. There is no online GC or global disk-usage bound.

Offline maintenance must stop all participating Pi processes and reclaimers. Inspect reviewed terminal artifacts individually. Never bulk-delete the lock root or erase native-pending evidence without independent settlement proof. PID death, elapsed time, and a fresh sign-in are not proof. Preserve refresh quarantine. There is no reset CLI or provider-side logout revocation. Follow the [README procedure](../../packages/pi-mcp/README.md#credential-coordination-recovery).

Ask User forms use genuine local-extension ownership and the existing FIFO of 16 pending slots. The capability admits at most 16 live calls. Forms have 0 to 16 flat fields, 64 choices per enum, 4,096-code-unit ordinary values/messages, 8,192-code-unit URLs, and 64 KiB request/answer limits. MCP additionally limits a form to 64 total enum choices, an operation to 8 dispatch rounds and 16 input requests, and input/response batches and opaque state to 64 KiB each. Sensitive-text rejection is a heuristic, not a complete secret detector.

SDK constructor capabilities stay empty. Only modern tool calls, resource reads, and prompt retrieval advertise per-request elicitation with a current same-session TUI/RPC provider. Legacy/headless sessions never advertise it. Answers and continuation state are not published to model replies, Activity, event logs, or retained results. URLs are full inert text with a prominent host. After consent, MCP rechecks authority, opens the system browser, and requires manual resume. No polling or automatic approval occurs.

Continuation authority is stricter than completed-result publication authority. A rejected connection cannot open another form/browser or dispatch another leg, while a separately completed reply may still publish under its captured current authority. The foreign Ask User cancellation waiter is bounded to one second. A module-wide process-local fence retains a token per unresolved attempt across runtime/session replacement until that exact Promise succeeds. Timeout or rejection does not prove cleanup; rejection leaves the fence in place.

Resource subscriptions allow 16 leases per connection owner and 32 per session. One owner finalizer visits only current entries; repeated normal subscribe/unsubscribe does not retain historical entry finalizers. Private identities exist before acquisition and survive through queued-event checks, but never enter public results. Raw modern ACK evidence permits up to 32 staged updates per subscription; SDK/filter acceptance is still required before queueing. Overflow contributes to `ingressDropped`. Readiness waits occur outside the registry lock, and stale generations never wait on a replacement. Legacy wire notifications cannot distinguish old server work first received after replacement.

HTTP subscription close joins actual source cancellation. Stdio cancellation tracks native write reservations and settlement independently of SDK logical close. A successful write is not a remote acknowledgement. Failed writes preserve ownership until child cleanup; unknown legacy pre-ACK establishment retires the connection. Logging requires explicit `logLevel`, modern HTTP, advertised logging, and exact request-stream provenance. Progress supports both transports, including bounded live top-level updates. `events.read` uses decimal-string cursors and pages of 1 to 100 events, default 32, from a 128-event/128 KiB ring with 4 KiB log/progress text. Observations are best-effort, not an audit log.

Header mirroring checks string/safe-integer/boolean types, valid UTF-16, standard names, and 64-header/16 KiB encoded bounds before HTTP send. Metadata TTL absent, invalid, nonpositive, or greater than one day gives zero freshness. Cursor continuation uses the current cached revision locally; refresh, notification evidence, and auth/configuration changes invalidate it without relaxing invocation freshness. Changed credentials retire the old owner before schema reuse. A later fresh request needs confirmed cleanup, with no automatic retry. Local result ownership also includes revocation generation.

## Verification record

The supervising session independently ran the final combined gates after the subscription corrections:

| Command or scope        | Result                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm validate`         | Passed. Includes synchronized versions, layout, diagnostic guard, typecheck, Effect diagnostics, lint, formatting, workspace tests, and packed-source clean-consumer checks. |
| MCP package tests       | 1,131 passed across 70 files. Package typecheck, lint, formatting, and Effect diagnostics also passed; zero diagnostic errors/warnings.                                      |
| Ask User package tests  | 206 passed across 22 files.                                                                                                                                                  |
| Core package tests      | 284 passed across 30 files, including 8 native-context tests.                                                                                                                |
| Code Mode package tests | 140 passed across 17 files.                                                                                                                                                  |
| Subagents package tests | 1,000 passed; 3 existing skips.                                                                                                                                              |
| `pnpm mcp:conformance`  | Both pinned 0.1.16 scenarios, `initialize` and `tools_call`, passed with explicit legacy selection and confirmed application cleanup receipts.                               |
| Source packaging        | Local advisor and packed TypeScript imports passed through Jiti in a clean consumer. No generated runtime prerequisite.                                                      |

Independent reviews and owned repros covered foreign-cancel fencing, fresh continuation authority after a sibling 401, token-refresh metadata revocation, zero-TTL local cursors, retention-generation races, UTF-16 rejection, held HTTP source cancellation, legacy pre-ACK retirement, stdio cancellation-write failure, exact subscription IDs, and queued-generation rejection. The final 73-test subscription/stdio run covered lifetime retention and ACK-adjacent handoff corrections. The 100-cycle retention regression failed when the historical per-entry finalizer was temporarily restored, then passed with the fix. Same-write stdio ACK/update delivery likewise failed before its correction and passed afterward.

No new external server installation or real credential operation was performed for this follow-up. `mcp:smoke` was not rerun because it installs server packages and downloads a browser. Its historical filesystem/Playwright results and the earlier disposable native Keychain check remain evidence only for their recorded revisions. The two conformance scenarios do not establish full modern-protocol, transport, OAuth-provider, or OS conformance.

## Final acceptance

- [x] All authorized workstreams and confirmed review findings addressed.
- [x] Supported modern/legacy HTTP and stdio behavior verified through owned boundaries and actual local-child fixtures.
- [x] Private interaction, revocation, cancellation, cleanup, and recovery regressions pass.
- [x] Narrow package checks and final combined validation passed.
- [x] Existing pinned conformance scenarios passed with cleanup receipts.
- [x] Documentation reconciled, formatted, and checked for whitespace errors.
- [x] No version changes, staging, commits, releases, permission engine, or new external compatibility setup.
