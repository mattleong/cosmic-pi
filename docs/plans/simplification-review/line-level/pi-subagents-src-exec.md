## pi-subagents: execution boundaries, backends and supervisor (src-exec shard)

This shard covers the Herdr CLI, host and harness, the local CLI harness and process transport, the Codex, Local Pi, Local Claude and Herdr backend drivers, the supervisor channel and MCP helper, the writer lease, git worktree publication, the native model catalog, and the host UI and profile adapters. Verification confirmed 73 findings, disputed 3, and dropped none. Four overlapping pairs were merged, which leaves **69 entries removing 1,083 source LOC and 34 test LOC**. Two of the merges were subsumed: sub-herdr-cli-process-6's 25 lines are inside sub-backend-1, and sub-backend-15's 12 lines are inside sub-herdr-cli-process-13. The other two merged pairs touch disjoint lines, so their counts are added. The test figure is net: 48 lines are removed (herdr-cli-process-4: 25, -5: 9, supervisor-writer-7: 14), and sub-backend-7 adds 14 fixture lines when it moves a test-only schema out of source. Risk is none for 58 entries and low for 11. Effort is S for 63 and M for 6. The main themes are duplicated Herdr and local plumbing (environment allowlists, envelope decoding, Claude argv, harness lifecycle), unread DTO fields, hand-rolled RPC frame and decode chains, and IIFE or switch boilerplate. I spot-checked the 8 largest entries against HEAD `1a866fa`: herdr-cli-process-4, herdr-cli-process-1, backend-1+herdr-cli-process-6, herdr-cli-process-2, supervisor-writer-2, supervisor-writer-1, backend-2 and herdr-cli-process-5. All claims and estimates hold, so **none were demoted**. Paths are relative to `packages/pi-subagents/src/` unless they start with `tests/` or `packages/`.

| Category             | Entries |   Src LOC | Test LOC |
| -------------------- | ------: | --------: | -------: |
| duplication          |      31 |       531 |        0 |
| verbose-code         |      18 |       264 |        0 |
| dead-code            |       7 |       120 |       34 |
| shared-helper-reuse  |       4 |        72 |        0 |
| redundant-validation |       6 |        56 |        0 |
| indirection          |       2 |        22 |        0 |
| boilerplate          |       1 |        18 |        0 |
| **Total**            |  **69** | **1,083** |   **34** |

| Area                                      | Entries | Src LOC | Test LOC |
| ----------------------------------------- | ------: | ------: | -------: |
| Herdr CLI, host and harness               |      13 |     294 |       34 |
| Backend drivers                           |      16 |     290 |      -14 |
| Supervisor channel, MCP helper and bridge |      13 |     137 |       14 |
| Local CLI harness and process transport   |       8 |     140 |        0 |
| Native model catalog                      |       5 |      66 |        0 |
| Host UI, notifier and profile resolution  |       6 |      55 |        0 |
| Git worktree and publication              |       6 |      51 |        0 |
| Writer lease                              |       2 |      50 |        0 |

Dedup notes:

- **sub-backend-1 ⊇ sub-herdr-cli-process-6.** Both share the Claude policy argv between the Herdr and local launches. The entry uses backend-1's 38 lines, and process-6's 25 are not added.
- **sub-herdr-cli-process-13 ⊇ sub-backend-15.** Both derive ChildLaunchRequest and use a rest-spread. The entry uses process-13's 26 lines; backend-15 counted 12 for the spread and "about 14 more" for the Omit type.
- **sub-herdr-cli-process-10 + sub-backend-18.** Both apply the same IIFE-to-conditional-spread change in different files, so 12 + 6 = 18.
- **sub-backend-8 + sub-herdr-cli-process-19.** Both touch the tag union in `boundary/local-claude-debug.ts`. backend-8's 20 excludes its optional debug-entry reuse, and process-19's 10 counts that part, so 20 + 10 = 30.
- **sub-backend-3 and sub-backend-17** overlap slightly on ContactParentSchema's `kind` field, per a verifier. They stay as separate entries.

### Herdr CLI, host and harness (13 entries, 294 src / 34 test)

- **sub-herdr-cli-process-4 · Stop projecting Herdr snapshot fields that nothing reads; derive HerdrAgentSession from its schema** (40 src / 25 test · risk none · M)
  - Where: `boundary/herdr-cli.ts:153-202, 509-537, 552-577`
  - Proposal: Keep the Schema structs unchanged. Shrink HerdrSnapshot to protocol, workspaces `{workspaceId}`, tabs `{tabId, workspaceId}`, panes and agents. Drop `label` and `focused` from HerdrPane and `nativeSession` from HerdrAgent, and trim paneView, agentView and the decodeSnapshot mapping to match. Declare `type HerdrAgentSession = typeof SessionInfo.Type` and set `agentSession: { ...agent.agent_session }`. The fixture and test literals drop the same keys.
  - Why behavior holds: Decoding stays exactly as strict. Spot-check: a grep of src finds no reader of version, focus, label, activeTabId, paneCount or HerdrAgent.nativeSession outside herdr-cli. The fixture keeps its own focus state. This pairs with herdr-cli-process-5, which removes the herdr-host DTO copies of nativeSession.
- **sub-herdr-cli-process-1 · Derive the captured Herdr environment allowlist and share one picker** (40 src · risk low · M)
  - Where: `boundary/herdr-environment.ts:2-47`, `boundary/herdr-cli.ts:264-294, 599`, `boundary/herdr-harness.ts:56-59, 120-127, 190-195`, `boundary/herdr-codex-hooks.ts:20-24, 279-285`, `boundary/harness-shared.ts:1-22`
  - Proposal: Add `pickEnvironment(source, keys)` to harness-shared.ts. Export the CLI list and the harness SAFE list from herdr-environment.ts, and define the captured set as their union plus CODEX_HOME and OPENAI_API_KEY. The lists live there, not in herdr-cli, to avoid a load-time TDZ cycle. herdr-cli, herdr-harness and herdr-codex-hooks import their lists and call the picker.
  - Why behavior holds: Each service picks in its own list order, so the spawned env and the `env -i` assignment order stay byte-identical. Only the captured snapshot's key order changes. Every consumer re-picks from it by key, and the one test uses toMatchObject. Spot-check: the 24-key and 23-key lists, plus OPENAI_API_KEY, are exactly the 29 captured keys.
- **sub-backend-1 + sub-herdr-cli-process-6 · One Claude policy argv builder for the local and Herdr launches** (38 src · risk low · S)
  - Where: `backend/claude-policy.ts:93-99, 136-143, 172-217`, `boundary/herdr-harness.ts:21-28, 212-251, 490`, `backend/local-claude.ts:77-83`
  - Proposal: Split out an exported `claudePolicyArgv(launch, harness, writerPolicy)` for the shared flags. The local claudeArgv adds its stream-json head. Herdr uses `["--name", request.name, ...claudePolicyArgv(...)]` and deletes its private 38-line builder and five constant imports. claudeAllowedTools appends CLAUDE_NATIVE_AGENT_TOOLS itself, and local-claude.ts uses `new Set(CLAUDE_NATIVE_AGENT_TOOLS)` instead of redeclaring it.
  - Why behavior holds: The flags, values, tool lists and settings JSON are the same. backend-1's layout reorders boolean flags only (local `--no-session-persistence`; Herdr `--no-chrome`/`--disable-slash-commands`), and no test pins argv order. process-6's variant keeps each head exactly as it is: risk none, but only 25 lines. The shared builder also removes drift in security-relevant tool policy. Spot-check confirmed that herdr-harness.ts:212-249 copies the policy tail element for element.
- **sub-herdr-cli-process-2 · One envelope-result decoder for the five Herdr CLI responses** (35 src · risk none · S)
  - Where: `boundary/herdr-cli.ts:141-151, 539-551, 580-594, 606-630, 654-656, 677-679, 706-708, 744-768, 786-817`
  - Proposal: Add a generic `decodeResult(schema, operation, invalidMessage)`: decodeEnvelope, then `Schema.decodeUnknownEffect(schema)` with failures mapped to `protocolError(op, "herdr_protocol_invalid", msg)`. Use it at all five sites. Delete the four `decodeXEnvelopeEffect` constants and `json` (its timeout is never passed). Define `ok` directly and reuse it for renamePane. Add a local `asReadiness` for the three preflight mapErrors.
  - Why behavior holds: 'session snapshot', 'resolve calling pane' and 'inspect pane shell' are not in MUTATING_OPERATIONS, so protocolError returns the same processError they build today. The strings and codes are unchanged (spot-checked).
- **sub-herdr-cli-process-5 · Remove never-read HerdrHostedAgent, OwnedRun and prepared-harness fields, and the sessionIdentity chain** (22 src / 9 test · risk none · S)
  - Where: `boundary/herdr-host.ts:41-55, 84-98, 521-535, 549-560`, `boundary/herdr-cli.ts:205-206, 601, 737`, `boundary/herdr-harness.ts:74, 449`
  - Proposal: Drop runId, runtime, terminalId, nativeSession, agentSession and sessionIdentity from HerdrHostedAgent. Drop runtime and nativeSession from OwnedRun, sessionIdentity from HerdrCliContract and makeHerdrCli, and runtime from HerdrPreparedHarness and `complete()`. Update the herdr-backend fake host, the fixture's `cli.sessionIdentity` and the smoke `nativeSession` assertion.
  - Why behavior holds: backend/herdr.ts reads only inspect, prompt and close (spot-checked). Ownership uses `OwnedRun.identity`, which stays. The smoke assertion is already guaranteed by `herdr_agent_session_unconfirmed`.
- **sub-herdr-cli-process-3 · Replace callingPaneTopologyMatches with herdr-host's exactPaneContext** (28 src · risk none · S)
  - Where: `boundary/herdr-cli.ts:299-326, 694`, `boundary/herdr-host.ts:127-128, 140-152, 165, 222-223`, `boundary/herdr-launch-safety.ts:49-52, 60-61`, `backend/herdr-ownership.ts:90-106`
  - Proposal: Move exactPaneContext into backend/herdr-ownership.ts as a pure export that returns the matched `HerdrPane | undefined`. Use it in herdr-cli, herdr-host and herdr-launch-safety. That drops the launch-safety parameter, the redundant exactPane check, the matchingPane wrapper and the `!` re-lookups.
  - Why behavior holds: The pane, terminal, workspace and tab uniqueness conditions are the same. herdr-ownership imports herdr-cli only as types, so there is no runtime cycle. docs/herdr-ownership.md already puts pure identity policy there.
- **sub-herdr-cli-process-10 + sub-backend-18 · Replace IIFE baseResult/withX chains with conditional spreads** (18 src, 12 + 6 · risk none · S)
  - Where: `boundary/local-cli-harness.ts:117-142`, `boundary/herdr-harness.ts:605-619`, `backend/herdr-ownership.ts:21-42`
  - Proposal: Return single literals with `...(codexApiKey && {...})`, `...(launch && {...})` and `...(options.integrationPaths && {...})`. In agentOwnershipEvidence, use `...(agent.cwd !== undefined && { cwd })` and the same for foregroundCwd.
  - Why behavior holds: Keys and insertion order are unchanged. The `!== undefined` guards keep empty-string cwd values. `&&` spreads pass anti-slop, which bans only `? {} :`.
- **sub-herdr-cli-process-11 · Trim repeated plumbing in herdr-harness prepareHarness and preflight** (15 src · risk none · S)
  - Where: `boundary/herdr-harness.ts:277, 403-407, 428-460, 484-499, 538-540, 685-688, 702-704, 746-749`
  - Proposal: Give `complete(argv, secretCommand?, extraEnvironment = {})` a third parameter so the Claude branch passes CLAUDE_CODE_SKIP_PROMPT_HISTORY. Share one `removeOwnedHarness(options, directory)` between both cleanup sites. Hoist the packaged `fileURLToPath` paths to module constants, and use `write(...)` for the settings, MCP and hooks files.
  - Why behavior holds: The env assignment order is unchanged, and `write` is exactly `ownedMutation(writeExclusive)`.
- **sub-herdr-cli-process-7 · Share the Codex `[features]` block** (14 src · risk low · S)
  - Where: `boundary/herdr-harness.ts:67-70, 311-316`, `boundary/local-cli-harness.ts:146-175`
  - Proposal: Move CODEX_DISABLED_FEATURES to harness-shared.ts along with `codexFeatureLines(openaiFastMode, hooks)`, and use it in both config builders. Herdr keeps using the constant for its `--disable` flags.
  - Why behavior holds: The Herdr config.toml is byte-identical. The local and catalog TOML only reorder keys inside `[features]`, with the same pairs, which TOML treats as equivalent. Tests use toContain.
- **sub-herdr-cli-process-20 · Remove the duplicated TrustInput type and a single-use error guard** (12 src · risk none · S)
  - Where: `boundary/herdr-codex-hooks.ts:85-111, 156-163`, `boundary/herdr-harness.ts:35, 396-399`
  - Proposal: Export TrustInput and use it in the contract. Type selectOwnedHook with `Pick<TrustInput, "cwd" | "hooksPath" | "command">`. Replace isHerdrCodexHooksError with `instanceof HerdrCodexHooksError`.
  - Why behavior holds: This is a type-only change plus an equivalent narrowing.
- **sub-herdr-cli-process-21 · Derive the receipt-phase union from its array; drop validation of test-only poll options** (12 src · risk low · S)
  - Where: `boundary/herdr-attestation.ts:17-23, 44-49, 156-181`
  - Proposal: Add a module-level `RECEIPT_PHASES = [...] as const` and `(typeof RECEIPT_PHASES)[number]`. Replace boundedPositiveInteger with `?? DEFAULT_POLL_*`.
  - Why behavior holds: Production passes no options. Only herdr-harness.test.ts passes them, always with valid values. An invalid test value would no longer silently fall back.
- **sub-herdr-cli-process-12 · Deduplicate the provisional-occupant predicate** (10 src · risk none · S)
  - Where: `boundary/herdr-host.ts:179-199, 337-346`
  - Proposal: Add a curried `provisionalOccupant(evidence)(agent)`. Use `!agents.some(...)` in provisionalSelectorsAbsent and `agents.filter(...)` in rollbackProvisional.
  - Why behavior holds: Both sites still read the evidence at call time, and the four-clause predicate is identical.
- **sub-herdr-cli-process-22 · Share micro-duplicated helpers** (10 src · risk none · S)
  - Where: `boundary/herdr-cli.ts:296-297`, `boundary/herdr-harness.ts:112-114, 357-360, 594-598`, `boundary/herdr-host.ts:100-105`, `boundary/herdr-attestation.ts:58`, `boundary/local-cli-process.ts:82-83`, `boundary/local-cli-harness.ts:286-296`, `run/workspace-control.ts:77-78`, `run/write-claim-control.ts:23-24`
  - Proposal: Export `invalidRequest(code, message)` from run/errors.ts and import it under the existing local names, for example `invalidRequest as readinessError`. Export shellQuote from harness-shared.ts and defectCause from herdr-harness.ts. Share removePrivateDirectory only if doing so does not lengthen local-cli-harness.
  - Why behavior holds: The six factories and the shellQuote and defectCause pairs are identical copies. Import reflow cuts the saving from 14 to 10.

### Backend drivers (16 entries, 290 src / +14 test)

- **sub-backend-2 · Codex driver: one rpcResult helper for the five RPC+decode chains, plus smaller dedupes** (32 src · risk none · M)
  - Where: `backend/local-codex.ts:140-146, 218, 314-319, 455-478, 533-565, 578-598, 627-638`, `backend/local-codex-protocol.ts:106-115, 148-149, 315-316`
  - Proposal: Add a local `rpcResult(makeRequest, ResultSchema, method)` that maps only decode failure to `Codex returned an invalid ${method} result.`. Export the five result schemas and delete the wrappers. Decode `envelope.item` with Item, and drop ItemStarted and ItemCompleted. Use `emptyUsage()`. Add `markTurnStarted(turnId, epoch, raw?)`, called lazily through Effect.suspend in `start()`.
  - Why behavior holds: The per-method error strings are identical (spot-checked). NativeItemEnvelope already validates threadId and turnId. The run_started dedupe and epochs are preserved.
- **sub-backend-8 + sub-herdr-cli-process-19 · One source for the Claude leading-tag diagnostic and the debug-ledger unions** (30 src, 20 + 10 · risk none · S)
  - Where: `backend/local-claude-correlation.ts:176-183, 198-224`, `boundary/local-claude-debug.ts:31-43, 63-83`
  - Proposal: Add `DIAGNOSTIC_LEADING_TAGS = [...] as const` and derive the union from it. The body becomes `tag === undefined ? "none" : (TAGS.find((k) => k === tag) ?? "other")`, with no switch and no cast. LocalClaudeDebugEntry references `ClaudeProtocolEvent["type"]` and ClaudeLeadingTagDiagnostic; the one-line unions are referenced only if the import stays compact.
  - Why behavior holds: Every input maps the same way, because the regex capture always has at least one character. The ledger changes are type-only.
- **sub-backend-5 · local-claude-protocol: drop the duplicate init interface, unused init fields, repeated control-frame builders and the marker alias** (24 src · risk none · S)
  - Where: `backend/local-claude-protocol.ts:10, 148-156, 211-220, 326-334, 400-419`, `backend/local-claude.ts:64, 139`
  - Proposal: Type the init Deferred with ClaudeInitProtocolEvent and delete ClaudeNativeInitialization. Drop `tools` and `mcpServers` from the normalized init event, but keep them required in SystemInit. Replace the three builders with a const-generic `controlFrame(request)(requestId)` that keeps the named exports. Export the marker directly.
  - Why behavior holds: The wire JSON and init validation are unchanged. The ReturnType-based frame types that native-model-catalog.ts uses still resolve.
- **sub-backend-7 · Move the test-only Pi usage schema (decodeRpcUsageOption) out of source** (23 src / +14 test · risk none · S)
  - Where: `backend/local-pi-protocol.ts:263-285`, `tests/run/fixtures/service-harness.ts:8, 222-234`
  - Proposal: Move the optional-usage schema into the fixture, which already imports Schema.
  - Why behavior holds: Production usage goes through local-pi-usage.ts Stats. This is mostly a relocation: the net across the repo is about 9 lines.
- **sub-backend-9 · Claude usage and correlation: one componentwise combinator and one bounded-window helper** (20 src · risk none · S)
  - Where: `backend/local-claude-correlation.ts:10-69, 317-342`, `backend/local-claude-usage.ts:23-34`
  - Proposal: `componentwise(f)` yields max, add and delta. Define `UsageComponents = Omit<SubagentUsage, "totalTokens" | "cost">`. Use one `rememberBounded(map, key, value, limit)` at the three LRU sites, and make internalReplayUuids a `Map<string, true>`.
  - Why behavior holds: The arithmetic, key order, eviction order and bounds are unchanged.
- **sub-backend-10 · Herdr handle: reuse `finish()` in the finalizer and add one failClosed helper** (20 src · risk none · S)
  - Where: `backend/herdr.ts:77-80, 90-97, 140-171, 179-197, 267-271`
  - Proposal: Write the finalizer as `Effect.sync(cancelPending).pipe(Effect.andThen(finish("Herdr backend scope closed.")))`. Use `failClosed(message, diagnostic)` at the four protocol_error+finish sites. Drop the unused exitCode parameter and use BackendExit.
  - Why behavior holds: The order (cancelPending, then end) and the exit object `{exitCode: null, diagnostic}` are unchanged.
- **sub-backend-11 · Local Claude handle: dedupe interrupt-evidence settlement, control sends, the digest and uncorrelated-message building** (20 src · risk low · M)
  - Where: `backend/local-claude.ts:106-107, 301-313, 359-402, 465-481, 617-628, 813, 829-842, 983-992`, `backend/local-claude-input-delivery.ts:70`
  - Proposal: Add `observeInterruptEvidence(interrupt, flag, raw)`, `sendControl(operation, frame)` and `uncorrelatedMessage(event, sequence, report)`, with diagnosticContext inlined into the last. Export one content digest, and call `inputs.send` directly.
  - Why behavior holds: Flags, settlement, codes and messages are unchanged. In the reject path, the Clock read moves after the read-only recordUserDecision, which can shift only the coarse sinceOutbound bucket.
- **sub-backend-3 · Local Pi IPC schemas: one helper for the 12 `channel: "pi-subagents"` structs** (18 src · risk none · S)
  - Where: `backend/local-pi-protocol.ts:78-152`
  - Proposal: Add a const-generic `piSubagentsMessage(type, fields)` that builds `Schema.Struct({ channel, type, ...fields })`.
  - Why behavior holds: Field order, literals and decode behavior are unchanged. It was typechecked against rc.112, and union narrowing is preserved.
- **sub-backend-4 · decodeRpcEnvelope: one Schema.Union instead of an 11-case switch** (17 src · risk none · S)
  - Where: `backend/local-pi-protocol.ts:179-227`
  - Proposal: Add `RpcEventSchema = Schema.Union([...])` and `RPC_EVENT_TYPES: ReadonlySet<string>` built from the member literals; the annotation is required for `.has`. Known types decode through the union and others through IgnoredEventSchema. Keep the decodeRpcEnvelope name and signature and the RpcResponse export.
  - Why behavior holds: The union selects the member by literal and strips extra keys the way a Struct does. Only the failure detail changes, and the sole caller maps failures to a fixed message.
- **sub-backend-12 · driver-shared: one `supervisorError(operation)` mapper for 12 sites; drop the single-use `decode` option** (16 src · risk none · S)
  - Where: `backend/driver-shared.ts:49-50, 78-80`, `backend/herdr.ts:201-203, 244, 290-292, 314-329, 350-356`, `backend/local-claude.ts:1042-1043, 1054-1057`, `backend/local-codex.ts:489-491, 524-525, 684-687`, `backend/local-cli-startup.ts:17-20`, `backend/local-pi.ts:254-267`
  - Proposal: Add `supervisorError(op) = ({ code, message }) => processError(op, code, message)`. local-pi applies its success check with `.pipe(Effect.flatMap(...))`.
  - Why behavior holds: The error fields are the same. The pure check now runs after unregister, which cannot be observed.
- **sub-backend-19 · Share the interactive-shell process-name predicate with pi-herdr-btw through pi-cosmic-core** (14 src · risk low · S · _cross-package_)
  - Where: `backend/herdr-shell-readiness.ts:11-33`, `packages/pi-herdr-btw/src/btw/validation.ts:21-37, 138-142`
  - Proposal: Add a pure `isInteractiveShellProcessName(name)` in a new core module, for example `src/platform/interactive-shell.ts`. Do not put it in the `process.ts` I/O adapter. Re-export it from index.ts, add one ARCHITECTURE.md source-map line, and delete both copies.
  - Why behavior holds: The two 15-name sets and the normalizers are byte-identical.
- **sub-backend-6 · Local Pi: stop decoding every RPC event twice** (12 src · risk none · S)
  - Where: `backend/local-pi.ts:87-159, 465`
  - Proposal: normalizeRpcEvent takes the already-decoded envelope and drops its inner decode and catch. Fold the no-event cases into `default`.
  - Why behavior holds: The outer catch offers the same protocol_error and raw, with no state change in between. It also saves one schema decode per child event.
- **sub-backend-13 · Replace the outcome-code switches with lookup Maps** (12 src · risk none · S)
  - Where: `backend/local-pi.ts:60-73`, `backend/local-codex.ts:82-93`
  - Proposal: Use `new Map<RpcCommand["type"], string>([...])` with `.get(c) ?? `${c}\_outcome_uncertain``, and the same for Codex keyed by `CodexRequest["method"]` with the replaceAll fallback. Do not use an annotated Record: anti-slop no-known-value-widening rejects it.
  - Why behavior holds: Every key maps to the same code.
- **sub-backend-14 · Local Pi resume token: Effect Schema instead of a hand-written guard and cast** (11 src · risk none · S)
  - Where: `backend/local-pi.ts:1-2, 161-183`
  - Proposal: Decode `Schema.Struct({ type: Literal, sessionFile: minLength 1 })` with the same error, and derive the type from it. Drop the Predicate and hasObjectRuntimeType imports and the SAFETY cast.
  - Why behavior holds: Plain-object tokens are accepted and rejected exactly as before, and only `.sessionFile` is read.
- **sub-backend-17 · local-pi-protocol: use Schema.Literals and the shared effort tuple; drop a dead export** (11 src · risk none · S)
  - Where: `backend/local-pi-protocol.ts:82-86, 178, 229-237`
  - Proposal: Use `EffortSchema = Schema.Literals(SUBAGENT_EFFORTS)` and `kind: Schema.Literals([...])`. Delete the never-imported ContactParentEnvelope.
  - Why behavior holds: The literal sets are the same, and tools/details-schema.ts:97 already uses this pattern.
- **sub-backend-16 · Local Pi: use the ownership helper's `release()`** (10 src · risk none · S)
  - Where: `backend/local-pi.ts:204-208, 371-372, 411-414, 419-422, 436-438, 449, 469-476`
  - Proposal: Write `return release(event)`, `normalized ? offer(...) : release(event)` and `Effect.ensuring(release(event))`.
  - Why behavior holds: The same raw event is released once, in the same fiber. The Claude and Codex drivers already do this.

### Supervisor channel, MCP helper and bridge (13 entries, 137 src / 14 test)

- **sub-supervisor-writer-2 · Bridge client: remove four frame interfaces and three builders for three literal frames** (33 src · risk none · S)
  - Where: `boundary/pi-supervisor-bridge-client.ts:39-69, 109-115, 194-222, 295-300`
  - Proposal: Use a generic `encodeFrame = <Frame>(frame: Frame) => ...`. Make the initialize and initialized frames module constants, build the tools/call literal inline in `call`, and route cancelNotification through encodeFrame. BridgeReply's initialized variant becomes `{ kind: "initialized" }`, and decodeBridgeInitializeResultOption still gates it.
  - Why behavior holds: The serialized bytes are identical, and argument typing is still enforced by `call<Name>`. Spot-checked.
- **sub-supervisor-writer-4 · MCP helper: merge the progress and warning callers; drop unreachable executeTool branches** (14 src · risk none · S)
  - Where: `boundary/supervisor-mcp-helper.ts:148-172, 236-271`
  - Proposal: Add `callContact(rpc: "SupervisorProgress" | "SupervisorWarning", message, signal)` that calls `liveClient()[rpc]({...})`. executeTool becomes: `!args` returns malformed, then report, proxy, question, and otherwise callContact. Remove the now-unused SUPERVISOR_MCP_PROXY_TOOL_NAME and SUPERVISOR_MCP_TOOL_NAMES imports, and keep the local result texts.
  - Why behavior holds: decodeToolArguments makes the `break`s and the trailing `malformed()` unreachable. Payloads, timeouts, signals and texts are unchanged; the verifier measured about 20 lines.
- **sub-supervisor-writer-5 · rpc-session: merge the 'reply' and 'rejection' settlement branches** (14 src · risk none · S)
  - Where: `boundary/rpc-session.ts:323-355`
  - Proposal: One combined case settles with `Effect.succeed` or `Effect.fail(RpcCallRejectedError)` by kind, followed by one unknown-reply branch.
  - Why behavior holds: Outcomes and the unknown-reply policy are unchanged. It also brings the file back under 500 lines.
- **sub-supervisor-writer-6 · rpc-session: remove micro-indirection** (12 src · risk none · S)
  - Where: `boundary/rpc-session.ts:69-71, 118-128, 136-139, 369-384, 418-421, 437`
  - Proposal: Store Deferreds directly and delete PendingEntry. Inline the single-use settlePendingWith, add an `outputOverflow()` factory, and drop the `failure` temporary.
  - Why behavior holds: failSessionSync keeps its order: pending waiters, then notify acks, then sessionFailed.
- **sub-supervisor-writer-7 · Remove Codex MCP fields and runId copies that nothing reads from the connection metadata** (10 src / 14 test · risk none · S)
  - Where: `boundary/supervisor-channel.ts:71-77, 80, 91, 129-171, 358-363, 389-395`, `tests/fixtures/backend-supervisor.ts:8-65`, `tests/herdr-harness.test.ts:114-142`
  - Proposal: Reduce codexMcp to `{ tomlFragment }` and inline SUPERVISOR_MCP_TOOL_NAMES into the TOML. Drop runId from the metadata, the handle and makeMetadata. In tests, collapse `{ ...supervisor, runId }` to `supervisor` in the herdr-host and herdr-host-ownership tests (38 sites), and drop the fixture's runId parameter (6 callers).
  - Why behavior holds: The TOML and the Claude MCP JSON are byte-identical, and src reads only tomlFragment and claudeMcp. The verifier measured about 15 src and about 130 test lines; the table uses the conservative 10 and 14.
- **sub-supervisor-writer-9 · MCP helper: stop converting the Effect writer to Promises and back** (10 src · risk low · S)
  - Where: `boundary/supervisor-mcp-helper.ts:76-79, 87, 105-108, 273-277, 360-362, 401-409`
  - Proposal: Store the writer as `Effect.Success<ReturnType<typeof makeSerializedWriter>>`. writeToolResponse becomes `stdout.write(v).pipe(Effect.catch(() => Effect.sync(failChannel)))`. Keep a Promise runner only in sendRpc. Delete SerializedWriter, runWriter, the adapter and the two tryPromise wrappers, and update docs/local-backends.md:106.
  - Why behavior holds: The frames, their order and the uninterruptible commit are unchanged, and every failure still reaches failChannel.
- **sub-supervisor-writer-8 · Session: drop the AcceptedReport record that duplicates BackendReport** (8 src · risk none · S)
  - Where: `boundary/supervisor-channel-session.ts:93-99, 143, 570-582, 614-619, 775-777`
  - Proposal: Type the map as `Map<SupervisorDeliveryId, BackendReport>`, read fields from the report, and delete AcceptedReport.
  - Why behavior holds: The values are identical by construction, and the same instance is returned.
- **sub-supervisor-writer-11 · Supervisor RPC handlers: stop re-validating schema-decoded payload fields** (7 src · risk low · S)
  - Where: `boundary/supervisor-channel-session.ts:28, 253, 304-305, 438-439, 568-569`, `supervisor/protocol.ts:63-76, 98-102`
  - Proposal: Remove the isSupervisorMcpMessage and isSupervisorMcpReport checks, the version clause in authorize, and the mcp-contract import. SUPERVISOR_CHANNEL_VERSION stays.
  - Why behavior holds: RpcServer.make decodes every payload first, with the same bounds and `Literal(3)`. No test pins the removed codes.
- **sub-supervisor-writer-12 · Session: remove the failPendingQuestion alias and restated event-capacity arithmetic** (6 src · risk none · S)
  - Where: `boundary/supervisor-channel-session.ts:150, 166-194, 306-314, 464-472, 523-524, 603-606`
  - Proposal: Delete cancelPendingQuestion by giving publishCancellation a default of true. Add `hasEventCapacity(reserved)`, called with 2 for contact, 2 or 3 for proxy and 1 or 2 for report, and drop contactEventCapacity. Skip the LOC-neutral offerContactEvent helper.
  - Why behavior holds: The integer inequalities are algebraically identical.
- **sub-supervisor-writer-13 · Fold the repeated guard, authorize, requirePeer and epoch prologue** (6 src · risk none · M)
  - Where: `boundary/supervisor-channel-session.ts:245-295, 324-340, 344-622`
  - Proposal: authorize resolves and returns the guard. authorizePeer and authorizeAssignment chain lazily, so each handler's prologue becomes one `yield*`.
  - Why behavior holds: The check order and failures are the same. The verifier measured 10 lines.
- **sub-supervisor-writer-14 · Serialized MCP writer: drop the pending counter that always equals `acknowledgements.size`** (6 src · risk none · S)
  - Where: `boundary/supervisor-mcp-writer.ts:20-70`
  - Proposal: Delete `pending`, check capacity against `acknowledgements.size`, and use `Effect.ensuring(Effect.sync(() => acknowledgements.delete(frame.ack)))`.
  - Why behavior holds: The counter and the set move in lockstep on every transition, including close.
- **sub-supervisor-writer-15 · protocol.ts: one message payload for Progress, Warning and Question** (6 src · risk none · S)
  - Where: `supervisor/protocol.ts:158-189`
  - Proposal: Share a `MessagePayload` fields object across the three RPCs. A `contactRpc(tag)` factory is optional.
  - Why behavior holds: The schemas, tags and wire encoding are unchanged.
- **sub-supervisor-writer-16 · supervisor-channel.ts: small redundancies** (5 src · risk low · S)
  - Where: `boundary/supervisor-channel.ts:120-121, 301-304, 341`, `boundary/supervisor-channel-session.ts:111-112`
  - Proposal: Drop the redundant `prepared` reassignment, import channelError from the session module, and use `options.authTimeoutMillis ?? AUTH_TIMEOUT_MILLIS`.
  - Why behavior holds: Production never sets the timeout, and the only test value (10) is within the clamp.

### Local CLI harness and process transport (8 entries, 140 src)

- **sub-herdr-cli-process-13 + sub-backend-15 · Derive ChildLaunchRequest from BackendLaunchRequest** (26 src · risk none · S)
  - Where: `boundary/child-process.ts:52-69`, `backend/local-pi.ts:664-689`
  - Proposal: Define `type ChildLaunchRequest = Omit<BackendLaunchRequest, "closeOnReport" | "resumeToken"> & { readonly resumeSessionFile?: string | undefined }`. In local-pi, write `const { closeOnReport: _c, resumeToken, ...launch } = request` and spawn `{ ...launch, ...(resumeSessionFile && { resumeSessionFile }) }`.
  - Why behavior holds: run/launch.ts sets the optional fields only through truthy spreads, and child-process tests them for truthiness. resumeSessionFile is still omitted when undefined, and the test literals still typecheck.
- **sub-herdr-cli-process-8 · safeCodexSourceHome: reuse safeAgentDirectory** (21 src · risk none · S)
  - Where: `boundary/harness-shared.ts:49-72, 91-118`
  - Proposal: `safeCodexSourceHome = (env) => safeAgentDirectory(env.CODEX_HOME ?? join(env.HOME || homedir(), ".codex")).catch(() => undefined)`.
  - Why behavior holds: The checks and the lstat, realpath, lstat chain are the same. Every rejection maps to undefined, and an empty CODEX_HOME still fails isAbsolute.
- **sub-herdr-cli-process-9 · Share the local harness directory lifecycle and Codex-home setup; remove the unused after-codex-auth fault seam** (20 src · risk none · M)
  - Where: `boundary/local-cli-harness.ts:58, 182-284, 250-255, 305-349`, `boundary/herdr-harness.ts:106, 536`
  - Proposal: Add private `prepareOwnedHarness(agentDirectory, rootName, namePrefix, build, cleanup = removeLocalCliHarness)` and `prepareCodexHome(directory, config, environment)`. Both preparers go through them and pass their existing fault seams. Delete 'after-codex-auth', which nothing produces.
  - Why behavior holds: The step order, restore placement, errors and cleanup mapping are unchanged.
- **sub-herdr-cli-process-14 · Remove duplicated local transport and request types** (20 src · risk none · S)
  - Where: `boundary/local-cli-process.ts:39-43, 75-80`, `boundary/local-cli-transport.ts:25-33, 62-67`, `boundary/child-process.ts:71-80`
  - Proposal: Use LocalCliHarnessRequest, export processError from local-cli-transport, and express ChildWireEvent and LocalCliWireEvent as `ProcessWireEvent<...>`.
  - Why behavior holds: This is type-only apart from sharing one verbatim function. `exit.signal` narrows to `string`, which the only producer already emits.
- **sub-herdr-cli-process-15 · Flatten releaseChildProcess into Effect.gen** (15 src · risk none · S)
  - Where: `boundary/process-transport.ts:45-84`
  - Proposal: A linear gen: requestAbort, sleep, `exit(graceful)`, then waitForExit. On exit, run the win32 check or sleep and force. Otherwise run `exit(force)` and waitForExit, then fail if either failed.
  - Why behavior holds: Sleeps, timeouts and errors are unchanged. waitForExit must still be yielded before forceAttempt is tested so that the 2-second wait still happens.
- **sub-herdr-cli-process-16 · Collapse the repeated transport_not_sent branches in send** (15 src · risk none · S)
  - Where: `boundary/process-transport.ts:271-318`
  - Proposal: A local `notSent(operation, error)` for the four branches.
  - Why behavior holds: The operations, codes and the defect and uncertain branches are unchanged, and the callback still returns undefined.
- **sub-herdr-cli-process-18 · Reuse nodeErrorCode instead of hand-rolled code extraction** (12 src · risk none · S)
  - Where: `boundary/child-process.ts:137-144`, `boundary/process-tree.ts:11-12, 40-49, 163`
  - Proposal: Use nodeErrorCode for the allow-list and ESRCH checks. systemErrorCode becomes the regex applied to nodeErrorCode. Drop the unused imports and the SAFETY cast.
  - Why behavior holds: A non-string code could never match the literals.
- **sub-herdr-cli-process-17 · Build both Local Pi IPC ports from one adapter** (11 src · risk none · S)
  - Where: `boundary/local-pi-ipc.ts:118-135, 180-199`
  - Proposal: Add `eventPort(target: Pick<NodeJS.EventEmitter, "on" | "off">, connected, send)`.
  - Why behavior holds: The events and listeners are the same, and the LocalPiIpcPort interface and test fakes are unchanged.

### Native model catalog (5 entries, 66 src)

- **sub-boundary-host-git-3 · Extract the duplicated bounded-byte stdout/stderr pipeline** (18 src · risk none · S)
  - Where: `boundary/native-model-catalog.ts:323-345, 379-401`
  - Proposal: A local generic `bounded(stream, label)` with its own counter per call. stdout then decodes text; stderr runs `runDrain` and then `never`.
  - Why behavior holds: The codes, messages and raceFirst order are unchanged.
- **sub-boundary-host-git-2 · Use Schema.is instead of decode-to-Option wrappers and hand-written guards** (17 src · risk none · S)
  - Where: `boundary/native-model-catalog.ts:151-160, 257-258, 273-281, 295-298, 359-362`
  - Proposal: Apply `Schema.is` to the two correlated-frame schemas and the two error-response schemas, delete the aliases and guards, and pick isCorrelated by runtime, annotated as `(value: unknown) => boolean` if needed.
  - Why behavior holds: These schemas have no transformations, so accept and reject results are identical. The verifier measured 22.
- **sub-boundary-host-git-5 · Drop the unused timeoutMillis option and the parameter threading** (14 src · risk none · S)
  - Where: `boundary/native-model-catalog.ts:196-197, 283-291, 299-301, 407, 473-521, 535-547`
  - Proposal: Use CATALOG_TIMEOUT_MILLIS directly. runCatalogProcess computes `catalogFrames(runtime)` itself, and discoverCatalog derives executable and sourceEnvironment.
  - Why behavior holds: No caller sets the option. The verifier measured 24.
- **sub-boundary-host-git-4 · Use pi-cosmic-core hasControlCharacter for the catalog filters** (12 src · risk none · S)
  - Where: `boundary/native-model-catalog.ts:46-62`
  - Proposal: The filters become `!hasControlCharacter(v)` and `!hasControlCharacter(v.replace(/[\t\n\r]/gu, ""))`.
  - Why behavior holds: `\p{Cc}` equals the loop ranges, which the verifier checked for every UTF-16 code unit.
- **sub-boundary-host-git-6 · Derive the effort allow-list from SUBAGENT_EFFORTS** (5 src · risk none · S)
  - Where: `boundary/native-model-catalog.ts:203-210`, `domain/routing.ts:15-23`
  - Proposal: `new Set(SUBAGENT_EFFORTS.filter((e) => e !== "off"))`, typed `ReadonlySet<string>`, keeping the exact-match filter.
  - Why behavior holds: It produces the same six-element set.

### Host UI, notifier and profile resolution (6 entries, 55 src)

- **sub-boundary-host-git-16 · Tighten the activity widget** (18 src · risk none · S)
  - Where: `boundary/host-activity-widget.ts:73-100, 155-164, 259-265, 326-347`
  - Proposal: Build the lease snapshots with flatMap, and use an object-literal empty component, the same pattern as pi-cosmic-ui host-activity.ts. Declare `ActivityWidgetComponentOptions extends Omit<SubagentActivityWidgetHostOptions, "getNow">` and build it with a spread.
  - Why behavior holds: The frozen contents and their order, the empty render and the callbacks are unchanged. The verifier measured 23.
- **sub-boundary-host-git-12 · Merge boundedCompletionSection and boundedCompletionBody; inline completionWarning** (12 src · risk none · S)
  - Where: `boundary/host-notifier.ts:55-72, 82-102, 116, 147-167`
  - Proposal: One `boundedCompletion(run, text, maximumLength)`. Reuse the section already computed, and fold the warning into completionBody.
  - Why behavior holds: The output is byte-identical.
- **sub-boundary-host-git-13 · hostProfileEnvironment: one literal instead of an IIFE and staged copies** (10 src · risk none · S)
  - Where: `boundary/host-profile-resolution.ts:155-185`
  - Proposal: Return a single object with `...(ctx.model && { parentModel })`, and keep the SAFETY comment.
  - Why behavior holds: The host call order and the keys are unchanged.
- **sub-boundary-host-git-15 · Remove the onChange parameter that no caller supplies** (6 src · risk none · S)
  - Where: `boundary/host-activity-widget.ts:48-50, 59-64`
  - Proposal: Make it a zero-argument factory and delete the guarded onChange call.
  - Why behavior holds: The only caller, host-ui.ts:49, passes nothing.
- **sub-boundary-host-git-14 · Remove the unreachable post-selection write_claims_read_only check** (5 src · risk none · S)
  - Where: `boundary/host-profile-resolution.ts:446-450`; the proof is at 265-272 and 363-376
  - Proposal: Delete the 5 lines.
  - Why behavior holds: tryAttempt already skips non-writers when claims are set, and run/launch.ts:71-75 still rejects at admission.
- **sub-boundary-host-git-17 · Build activity items as one literal** (4 src · risk none · S)
  - Where: `boundary/host-activity.ts:57-113`
  - Proposal: Compute `route` first, then return one frozen literal with `&&` spreads for profile, endedAt and parent. Do not use `? {...} : {}`, which anti-slop rejects.
  - Why behavior holds: The keys, their order and the freezing are unchanged.

### Git worktree and publication (6 entries, 51 src)

- **sub-boundary-host-git-7 · Publication helper createDirectory: reuse anchorMatches, a hoisted syncDirectory and an anchor validator** (12 src · risk none · S)
  - Where: `boundary/git-worktree-publish-helper.ts:59-66, 123-128, 157-164, 228-255`
  - Proposal: Hoist syncDirectory to module level, add a validAnchor shared with validRequest, and use anchorMatches.
  - Why behavior holds: The same syscalls run in the same order, and failures still end as PublicationHelperError.
- **sub-boundary-host-git-8 · Simplify the publication launcher** (10 src · risk low · S)
  - Where: `boundary/git-worktree-publish.ts:12, 32-34, 35-59, 61-88`, `boundary/git-worktree-publish-helper.ts:20-25`
  - Proposal: Give launch a `result: Schema.Codec<A, unknown>` parameter and decode there. `base64(image?)` returns `image && { bytes, mode }`, and the call passes explicit before and after keys. Export DirectoryWireRequest from the helper, and delete MutablePublicationWireRequest, the local type and the dead `export type { PublicationResult }`.
  - Why behavior holds: JSON.stringify drops undefined keys, so the stdin bytes and the 48 MiB check are unchanged. Wire building becomes eager, but it cannot throw.
- **sub-boundary-host-git-10 · Add treeOf and subdirectory helpers to the git workspace engine** (10 src · risk none · S)
  - Where: `boundary/git-worktree.ts:96, 126-134, 193-196, 302-305, 344-347, 376-379`
  - Proposal: Module-level `treeOf(repository, revision)` and `subdirectory(record)`.
  - Why behavior holds: The git argv and call order are the same.
- **sub-boundary-host-git-9 · Collapse repeated Map lookups when building the publication journal and requests** (9 src · risk none · S)
  - Where: `boundary/git-worktree-integration.ts:5-9, 109-132, 164-177`
  - Proposal: Bind `expected` and `content` once, use `x && {...}` for the journal's before and after, pass one request literal with conditional spreads, and drop the type import.
  - Why behavior holds: The values and key order are the same.
- **sub-boundary-host-git-11 · Derive the snapshot staging type from SnapshotEntry** (6 src · risk none · S)
  - Where: `boundary/git-worktree-snapshot.ts:182-188`
  - Proposal: `Array<Omit<SnapshotEntry, "oid"> & { readonly symlinkTarget?: string }>`.
  - Why behavior holds: The change is type-only.
- **sub-boundary-host-git-1 · Share one ENOENT-tolerant workspaceIO helper** (4 src · risk none · S)
  - Where: `boundary/git-worktree-process.ts:8-16, 125-130`, `boundary/git-worktree.ts:36-41`, `boundary/git-worktree-recovery.ts:99-104`, `boundary/git-worktree-snapshot.ts:55-63, 78-83`, `boundary/git-worktree-store.ts:37-42`, `boundary/git-worktree-integration.ts:84-92`
  - Proposal: Add `workspaceIOIfPresent(operation, run)` that maps ENOENT to undefined; the boolean sites compare the result to undefined.
  - Why behavior holds: The syscalls, labels and WorkspaceError are unchanged. oxfmt's import reflow cancels most of the saving: the measured diff is 47 lines added and 51 removed.

### Writer lease (2 entries, 50 src)

- **sub-supervisor-writer-1 · Reuse harness-shared writeExclusive for the evidence writes** (32 src · risk low · S)
  - Where: `boundary/writer-lease.ts:311-312, 339-390, 667-691`, `boundary/harness-shared.ts:36-47`
  - Proposal: `writeEvidenceFile(path, evidence)` checks the size and then calls writeExclusive. It is used in writeOwnedEvidence and markSpawnStarted with their existing catch chains, keeping the retained-artifact comment.
  - Why behavior holds: Outcomes and messages are the same. writeExclusive's O_NOFOLLOW and `chmod 0o600` are no-ops on a file just created with `O_EXCL` at mode 0o600. If zero risk is required, a local helper without the chmod nets about 22 lines. Spot-checked.
- **sub-supervisor-writer-3 · Share the lease-identity and ownership comparisons; drop the IIFE in conflict()** (18 src · risk none · S)
  - Where: `boundary/writer-lease.ts:173-191, 396-405, 627-636, 651-654, 722-727, 740-748, 766-769, 803-806`
  - Proposal: Add a `validLeaseIdentity(lease)` closure and a module-level `sameOwner(evidence, owner)` for the five sites. conflict() becomes a ternary between two complete objects.
  - Why behavior holds: The pure checks keep their short-circuit order, and the owner fields are still omitted when there is no evidence.

### Structural notes (unverified)

- **Claude and Codex interrupt skeleton** (~60): Both implement pending rejection, lifecycle registration, awaiting both results under a timeout, and ownership classification on release. A generic helper would conflict with ARCHITECTURE.md and docs/local-backends.md, which keep the two lifecycles separate, so it needs a design decision first. (`backend/local-claude.ts:953-1033`, `backend/local-codex.ts:599-682`)
- **runCatalogProcess and core openDuplexProcess** (~50): runCatalogProcess hand-rolls process plumbing that pi-cosmic-core's openDuplexProcess already provides. Migrating needs the detached, killSignal, env and catalog\_\* mappings re-verified against the probe-interruption and catalog tests.
- **Herdr and local readiness validators** (~45): They overlap on platform, model, effort, writer-cwd and auth checks, but word their messages differently. Unifying them changes observable error text.
- **Supervisor tool-argument contract** (~35): It is encoded four times: mcp-contract guards, protocol.ts Schemas, mcp-wire JSON Schema and TypeBox parameters. This is intentional while Pi requires TypeBox.
- **Owned private-directory lifecycle** (~30): After herdr-cli-process-9 there are still 4-5 copies (herdr-harness, local-claude-debug, supervisor-channel), which differ in operation names and quarantine rules.
- **Supervisor pending acknowledgements** (~30): The three kinds each have their own fail-on-peer-removal and fail-on-shutdown code. A keyed registry would touch delicate epoch settlement and question-cancellation semantics.
- **WorkspaceServiceContract** (~25): It restates the 11 engine methods, and the layer forwards each one. A mapped type would lose the hand-written domain contract that the fakes type against.
- **ChildProcessHandle and LocalCliHandle** (~15): Both are hand-written projections of acquireProcessTransport. A generic `ProcessTransportHandle<Message, Frame>` is complicated because `acknowledge` is optional.
- **herdr-host closeOwned and rollbackProvisional** (~15): After herdr-cli-process-12, one close-and-confirm-absent routine could serve both, but the quarantine side effects differ.
- **process-tree Promise door** (~12): It exists only for process-transport's `force`. A single `runFork` would remove it, at the cost of churning tests and moving a runner.
- **Handle transport plumbing across Claude, Codex and Herdr** (~12): Forwarding fibers, ensuring and finalizers are repeated, but a shared helper would save only 10-15 formatted lines.
- **LocalClaudeDebugEntry unions** (~10): It re-spells the correlation unions. This is covered by sub-backend-8 + sub-herdr-cli-process-19.
- **Ancestor lstat walks** (~10): requiredLeaseDirectories and publishWorkspace both walk ancestors, but their policies differ in security-relevant ways (fail-closed on unleased ancestors).
- **pi-herdr-btw selectHerdrEnvironment** (~8): It could share pickEnvironment (herdr-cli-process-1) if that helper moved to pi-cosmic-core.
- **Duplicate env scrub in supervisor-mcp-helper** (~4): It repeats the `.mjs` launcher's env scrub. It is deliberately kept as defense in depth.
- **Supervisor prompt sentences** (~3): The local and Herdr supervisor prompts share one sentence. A shared constant saves 1-2 lines, and unifying the wording would change prompts.
- **Oversized files** (0): host-child.ts is 546 lines, of which registerSubagentChildBridge is about 430. host-profile-resolution.ts is 599, native-model-catalog.ts 615, git-worktree.ts 505, herdr-harness.ts 775 and rpc-session.ts 500. Splitting them would not reduce LOC.
- **Scan-hint false positives, verified** (0): publicationMain and host-child's default export are loaded by path (jiti or the child extension). The test seams are legitimate, and the clone hints against claude-policy, routing imports, resume, herdr-ownership and pi-mcp are coincidental.

### Needs a decision

- **sub-backend-20 · One local-CLI driver factory for the Claude and Codex drivers** (8 src claimed · risk none · S). Where: `backend/local-claude.ts:1066-1079`, `backend/local-codex.ts:696-709`, `backend/local-cli-startup.ts:9-23`.
  - _For:_ The two drivers differ only in the runtime literal and the handle factory, startLocalCli has no other caller, and a typed `(launch, child, supervisor) => Effect<BackendHandle, SubagentError, Scope>` factory keeps layer.ts and the tests unchanged.
  - _Against:_ The typed makeHandle parameter and extra imports make the factory longer than startLocalCli, and both wrappers keep their signatures. The realistic net is about 1-5 lines, below the threshold.
- **sub-boundary-host-git-18 · Inline the private single-caller env selectors in host-environment.ts** (7 src claimed).
  - _For:_ The two private selectors each have one caller, and inlining shrinks the file from 15 lines to about 8.
  - _Against (blocking):_ tsconfig.effect.json sets the Effect `processEnv` diagnostic to error. Direct `process.env.X` reads fail `pnpm effect:diagnostics` and therefore `pnpm validate`, and the selectors exist to avoid exactly that. Recommend not applying it.
- Skipped as trivial: **sub-supervisor-writer-10**, an `ownValueSatisfies` helper in mcp-contract.ts. It measures only about 3 net lines after oxfmt, and both reviewers call it low value in a hostile-input module that must stay import-free.
