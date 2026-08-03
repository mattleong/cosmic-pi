# pi-subagents

Session-scoped, profile-routed background subagents for Pi.

## Implemented behavior

- Seven built-in profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `generalist`.
- `subagent_start` accepts one required `agents` array (1–12 items). Each item contains only `task`, optional `profile`, and optional `name`.
- Start is always background and nonblocking. Launch independent workstreams early and continue working; unclaimed completion reports are delivered automatically. Use `subagent_await` with `all_finished` or `any_finished` only when progress or final synthesis depends on selected reports.
- Version-4 profile routes own host, runtime, model, effort, context, write intent, OpenAI fast mode, and report-close behavior. Native selectors use one fail-closed 256-character grammar across config, settings, and all six adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, including Pi registry context variants such as `cursor/gpt-5.5@1m`, plus Claude's optional exact long-context suffix such as `[1m]`.
- Ordered candidates receive bounded readiness preflight before run, lease, supervisor, or process ownership. Unavailable executables, unauthenticated CLIs, unsupported fresh/context/effort/write-policy combinations, and missing private-harness prerequisites become typed skips, allowing fallback to a later candidate.
- Once `SubagentService.start` begins, routing never falls through to another candidate; spawn or later outcome uncertainty is surfaced on that selected run and is never retried arbitrarily.
- A single shared backend registry implements all six `local|herdr` × `pi|claude|codex` adapters. Herdr selection uses only Pi's inherited Herdr socket/session environment, otherwise Herdr's default.
- Local Pi children support fresh context and native fork context, conservative read-only tools or writer tools, parent contact, guidance, interruption, resume, rename, stop, and bounded completion delivery.
- Local Claude Code uses the current print/SDK stream protocol: official `initialize` control, a zero-inference `shouldQuery:false` native-init probe, validated native model/session/cwd, mandatory connected supervisor MCP inventory, replay-confirmed input, and a correlated interrupt lifecycle. Interruption waits for the exact control response, replayed `[Request interrupted by user]`, and `error_during_execution`/`aborted_streaming` result in either order; unrelated failures remain failures. Its actual capabilities are steer, interrupt, and parent contact.
- Local Codex uses the generated 0.145 app-server v2 stdio JSON-RPC subset (`initialize`, `thread/start`, `turn/start`, `turn/steer`, and `turn/interrupt`) rather than terminal scraping. It uses a private `CODEX_HOME`, copies bounded validated auth from a safe custom source `CODEX_HOME` or the default source without forwarding that source path, otherwise uses the fixed API-key fallback, and enforces approval `never`, disabled web/tool-sandbox network, read-only/workspace-write sandbox policy, and fresh context only. Its actual capabilities are steer, interrupt, and parent contact.
- The backend contract includes bounded report events correlated by run and monotonic assignment epoch, with adapter-owned sequence plus `deliveryId` retry identity. Reports are committed only in the matching issued assignment phase and are in-memory protocol data, never project files.
- Local and Herdr Claude/Codex use a scoped, authenticated loopback `SupervisorChannel` and packaged concurrent stdio MCP helper. Herdr Pi loads one packaged private bridge extension/client exposing the same four tools through `pi-code-previews`. The channel carries bounded progress, warnings, one correlated blocking question per assignment, and idempotent report delivery without project report files.
- `closeOnReport: false` has backend-neutral retained lifecycle semantics: a report finishes the current assignment as `reported`, increments `reportGeneration`, and keeps the read-only backend resource available for guidance and later report generations. Await owns the current/next generation with one exclusive cancellation-safe token; competing awaits fail with `completion_claim_conflict`, competing status redacts the report, and unclaimed reports are delivered once by `(runId, generation)`.
- History is capped at 50 total records and each retained run at 64 unresolved report generations. Start rejects with `history_outbox_capacity` instead of exceeding the total bound when unresolved delivery or cleanup prevents eviction.
- At most one writer owns the same stable local directory identity (device + inode/file ID) across same-host parent Pi processes using the shared private agent directory, independent of backend driver. Symlink/relative aliases and directory renames collide; read-only runs acquire no lease. Failed, transitional, or uncertain ownership remains fail-closed on disk and quarantined in session.
- Every extension-owned tool is rendered through the cooperative `pi-code-previews` shell. Tool calls use bounded user-facing action/task/message summaries; results use persisted semantic route/run/action cards with IDs, safety intent, retention, timing/activity, humanized usage, mixed-target recovery, report previews, and explicit omission evidence. Every tool-card model route uses compact `model:effort ⚡` notation when its candidate uses OpenAI priority service.

All six adapters are self-contained. Herdr runs are owned by the current parent Pi session. The parent creates one private shared Herdr workspace/tab for its cwd, records exact pane/terminal/agent/native-session evidence, closes only revalidated owned topology, and never adopts restored native sessions. `closeOnReport:false` retains only read-only panes for later assignments in the same parent session. Writers always close and use the same parent-owned canonical-cwd lease as local writers.

For Claude and Codex, supervisor MCP report delivery—not raw final CLI text—owns completion. Local candidates always close on report, and process scope closes before writer lease release. Supervisor progress, warning, exact correlated question/reply, and report identities/sequences are forwarded unchanged into the backend event queue. Claude stream input is accepted only after native replay confirmation (the CLI may apply guidance at its next safe turn boundary). Claude interruption includes `cancel_queued:true`. Codex interruption waits for both the correlated JSON-RPC success and matching `turn/completed(status=interrupted)` in either order and emits no later settlement event. Normal Claude and Codex completion both use exact-epoch causal `SupervisorChannel` acceptance evidence recorded before the MCP call is acknowledged, so an accepted report wins even while its queue event is behind progress and a missing/wrong-epoch report fails instead of hanging; Claude's epoch-zero native initialization result remains non-assignment evidence. Resume, rename, peer notice, fork, and retained local runs are not advertised.

## Profiles

Built-ins preserve the previous behavior with one explicit `local` + `pi` + `parent` candidate. `closeOnReport` is true. Profile defaults are:

| Profile      | Context | Write intent | Effort        |
| ------------ | ------- | ------------ | ------------- |
| `scout`      | fresh   | read-only    | low           |
| `researcher` | fresh   | read-only    | medium        |
| `planner`    | fresh   | read-only    | xhigh         |
| `worker`     | fresh   | writer       | high          |
| `reviewer`   | fresh   | read-only    | high          |
| `oracle`     | fork    | read-only    | high          |
| `generalist` | fresh   | read-only    | parent effort |

Omitting `profile` always selects `generalist`; specialized profiles must be explicit. The deprecated `defaultProfile` configuration field is accepted but ignored and removed on the next settings write. Existing version 4 `delegate` route keys and tool inputs are accepted as a temporary compatibility alias and normalize to `generalist`.

## Configuration version 4

Global configuration is `<agent-dir>/pi-subagents.json`. Trusted projects may override it at `<cwd>/<CONFIG_DIR_NAME>/pi-subagents.json` (normally `.pi/pi-subagents.json`). Untrusted project configuration is not read.

```json
{
  "version": 4,
  "profiles": {
    "reviewer": [
      {
        "host": "herdr",
        "runtime": "claude",
        "model": "claude-opus-5",
        "effort": "high",
        "context": "fresh",
        "writeIntent": "read-only",
        "closeOnReport": false
      },
      {
        "host": "local",
        "runtime": "pi",
        "model": "openai-codex/gpt-5.6-sol",
        "effort": "high",
        "context": "fresh",
        "writeIntent": "read-only",
        "fastMode": true,
        "closeOnReport": true
      }
    ],
    "worker": {
      "host": "local",
      "runtime": "pi",
      "model": "parent",
      "effort": "default",
      "context": "fresh",
      "writeIntent": "writer"
    },
    "scout": "disabled"
  }
}
```

A route is exactly `"disabled"`, one candidate, or a non-empty ordered candidate array (maximum 32). Candidate fields are:

- `host`: `local` or `herdr`;
- `runtime`: `pi`, `claude`, or `codex`;
- `model`: a bounded native runtime selector; Pi uses `parent` or canonical `provider/model`, including registry-owned `@` context variants;
- `effort`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `default` means the profile's soft default (shown as `<effective> (default)` in settings), while `generalist` inherits the current parent effort and falls back to `high`;
- `context`: `fresh` or `fork`;
- `writeIntent`: `read-only` or `writer`;
- optional `fastMode`, defaulting to false; when true, eligible Pi or Codex candidates request OpenAI's `priority` service tier;
- optional `closeOnReport`, defaulting to true.

Cross-field rules are strict:

- `fork` is valid only for `local` + `pi`;
- `parent` is valid only for `local` + `pi`;
- `fastMode: true` is valid only for Pi candidates using a supported OpenAI model (including a supported active `parent`) or Codex candidates whose native catalog advertises the `priority` tier;
- `closeOnReport: false` is valid only for Herdr-hosted read-only candidates.

Unknown candidate keys invalidate the complete present route, which then fails closed. Persistent precedence is trusted project over global over built-in. A temporary session override, when present, replaces that profile's complete loaded route above every persistent layer. Removed policy fields (`denied` and `discouraged`) and execution/lifetime fields are not part of v4 and produce unknown-key diagnostics.

Version 3 does not migrate silently. Activation fails closed with guidance to rewrite candidates and remove old policy fields; fix the file and run `/reload`.

### Temporary session overrides

`/subagents profiles session` opens the same ordered route editor in an in-memory Session scope. Press `s`, `g`, or `p` to switch Session, Global, or Project scope. Editing an inherited session route copies the complete currently active route before applying the selected change, so changing only one candidate model preserves fallback order and every safety field. Session changes apply immediately to new launches and `subagent_models`; active runs keep their admitted route. `i` clears the selected profile override and `X` clears every session override after confirmation.

Session overrides write no project, global, or Pi session-history data. They survive `/tree` navigation and `/reload`; reload refreshes the persistent base configuration and then reapplies the complete session routes. They clear on `/new`, `/resume`, `/fork`, quit, or process restart. Clearing an override reveals the persistent configuration loaded by the latest activation. Precedence is Session > trusted Project > Global > Built-in.

## Starting and waiting

For substantial work, first check whether the task contains at least two independent workstreams. Launch one to three bounded read-only assignments early in one batch, then continue the main agent's independent work. Good delegation candidates include unfamiliar or multi-package codebase reconnaissance, external research that can run beside local inspection, implementation planning, and independent review. Skip delegation for trivial or tightly serial tasks.

Prefer `scout`, `researcher`, `planner`, `reviewer`, and `oracle` for parallel work. Use `worker` only for an explicit implementation handoff while the main agent does not edit. There must be no more than one shared-cwd writer, counting the main agent; serialize writers unless isolated worktrees are available.

```json
{
  "agents": [
    {
      "task": "Map the authentication entry points, tests, and likely regression risks.",
      "profile": "scout",
      "name": "auth-scout"
    },
    {
      "task": "Independently review the authentication changes for correctness and missing tests.",
      "profile": "reviewer",
      "name": "auth-review"
    }
  ]
}
```

Legacy per-launch `execution`, `context`, `writeIntent`, `effort`, `backend`, and `model` fields are rejected with `[legacy_launch_override]` guidance. No public start path can request foreground execution.

Use `subagent_models` to inspect complete configured candidates and static eligibility; executable/auth/harness readiness is checked at launch. It does not claim unsupported backends are available. Completion reports that are not claimed by an await are delivered automatically. Use `subagent_await` only at a dependency or synthesis barrier, and use it rather than polling status; “finished” means the selected run's current assignment is `reported` or terminal, not necessarily that a retained host resource closed. A parent question returns early so the parent can call `subagent_reply` and await again. For a future retained run, `subagent_send` from `reported` begins the next assignment on the same backend resource; `resume` remains for paused or closed completed sessions where supported.

## Commands and tools

- `/subagents` opens the responsive TUI fleet inspector. Guidance, parent replies, next assignments, resume messages, and renames use visible in-workspace inputs rather than hidden base-editor prompts. Action progress/failures stay visible in the fleet; stop confirmation is modal. Narrow lists page with configured PageUp/PageDown keys and show their visible range, while duplicate display names include run IDs.
- `/subagents profiles` opens the full ordered version-4 route editor in Global scope; `/subagents profiles session|global|project` opens a specific scope. It refreshes Pi's authenticated model catalog before constructing the workspace, falling back to the last coherent snapshot with a warning if refresh fails. It can inspect, add (up to 32), edit, clone, move, remove, disable, or reset complete ordered routes. Session edits use revision-checked in-memory state and apply immediately; global/project edits retain optimistic document concurrency and require `/reload`. Candidate editing covers all six host/runtime combinations plus native model, effort, context, write intent, OpenAI fast mode, and report retention. Destructive actions require repeated-key confirmation, invalid intermediates are never committed, and source/shadow notices distinguish active session routes from saved persistent settings.
- Agent tools: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, and `subagent_rename`. Collapsed cards prioritize the requested action, outcome, route/safety identity, and next step; expanded cards add full IDs, wrapped provenance/capabilities, profile-candidate reasons, and preserved reports/errors. `subagent_models` renders effective route source and static eligibility separately from launch-time checks.

Read-only Pi remains a fixed tool-capability policy, not a filesystem sandbox or confidentiality boundary. Every local Claude launch now requires the current strict subprocess sandbox (`enabled`, `failIfUnavailable`, no unsandboxed fallback), an empty network allowlist with strict denial, and a filesystem write allowlist derived from the assigned cwd. A writer exposes Bash only through sandbox auto-allow, omits Write/NotebookEdit, and grants Edit only through a canonical-cwd-scoped current permission pattern; bare Bash/Edit/Write never appear in `allowedTools` or `permissions.allow`. Unsupported writer paths/platforms fail preflight with `claude_writer_confinement_unsupported`, and unavailable sandbox dependencies fail selected startup rather than running unsandboxed.

Claude's OS sandbox directly confines Bash and is the stronger boundary. Edit is a separate Claude file-tool permission policy, not a sandboxed subprocess; this adapter depends on the current CLI's scoped-path and symlink enforcement and does not claim a general OS boundary for file tools. Explicit WebFetch/WebSearch and model traffic are also outside the Bash network sandbox, so this is not a confidentiality/offline guarantee. Claude `--safe-mode` is not used because it removes the required stdio MCP path; empty setting sources, strict MCP, fixed tools, and validated native MCP inventory retain that helper while admin-managed policy can still apply. Codex uses its native read-only/workspace-write sandbox, while the adapter-owned supervisor MCP helper intentionally runs outside it. Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.

## Herdr host ownership and harnesses

Herdr candidates accept only the profile's native model/effort/context/write values. The CLI executable is fixed to `herdr`; no profile/config/session selector, executable, argv, or environment is accepted. Commands inherit only bounded `HERDR_SOCKET_PATH`/`HERDR_SESSION` selection from the parent environment (plus minimal CLI process environment), otherwise Herdr chooses its default session. Herdr Pi starts with extension discovery disabled, so models from extension-registered providers are omitted from its picker and rejected again before auth or topology ownership; local Pi remains eligible because its child loads discovered extensions. Protocol 17, current marker-validated runtime integrations, canonical executables, auth, effort/model syntax, write policy, and private bridge files are checked before topology is created. A readiness failure may skip to the next candidate. Any mutation timeout, launch uncertainty, or cleanup uncertainty after ownership begins is fail-closed and never falls through.

The parent session lazily creates one non-focusing project workspace/tab and records workspace, tab, pane, terminal, name/runtime, cwd evidence, and every available native `agent_session` field (`source`, `agent`, `kind`, and `value`). One comparator revalidates that full tuple for prompt, inspect, rollback, and close; an incompletely proven provisional occupant is quarantined rather than closed. Changed/restored topology is not adopted or closed. Automatic operations restore prior tab focus when practical. Confirmed report with `closeOnReport:true`, explicit stop, session replacement/tree navigation/reload, and shutdown close exact owned topology. Retained read-only panes remain only until that same parent session ends.

All native harnesses replace the pane shell with a fixed `env -i` environment before startup. The sole Herdr lifecycle integration is marker-validated and explicitly installed into generated private state:

- **Claude:** fixed model/effort, empty normal setting sources, `--no-session-persistence`, disabled nonessential traffic in generated settings, strict supervisor MCP, delegation/integration denylist, current strict subprocess sandbox, and cwd-scoped writer Edit policy. Writer cwd characters that cannot be represented safely in the comma-delimited allowed-tool/scoped-Edit grammar are rejected before lease or topology ownership. This disables Claude's resumable conversation transcript/history for the delegated session and the package writes no report/history file in the project. Exact limit: the inherited authenticated Claude installation may still maintain implementation-defined account, cache, diagnostic, or provider-side records outside the project; this is not an offline or zero-retention guarantee. Read-only retention is supported; writers always close.
- **Codex:** isolated private `CODEX_HOME`, bounded recursive `auth.json` copy or API-key fallback loaded from a 0600 private script (never secret argv/diagnostics), strict supervisor-only config, approvals `never`, optional `service_tier = "priority"` with only Codex's `fast_mode` feature enabled for that candidate, read-only/workspace-write sandbox, and web/apps/plugins/multi-agent/network extras disabled. Only read-only runs may be retained.
- **Pi:** fresh private session directory, fixed model/thinking, `PI_SUBAGENT_CHILD=1`, optional private fast-mode request injection of `service_tier: "priority"`, no discovered extensions/skills/prompts/themes/context, fixed read-only/writer built-ins, orchestration denylist, marker-validated Herdr lifecycle extension, and one packaged supervisor bridge extension. Environment-sourced model API keys are resolved before ownership and cross only through the 0600 private bootstrap consumed by that bridge; provider environment is never forwarded wholesale. Its four bridge tools use `withCodePreviewShell`, strict bounded inputs, concurrent correlated helper calls, and exact question replies.

Herdr protocol 17 confirms prompt submission but exposes no safe interrupt/resume/rename operation for this ownership model. Herdr drivers therefore advertise only `steer` and `parent-contact`; stop and await remain parent service operations. A missing/mismatched agent or native idle/done without an accepted supervisor report fails the run. Pi/Claude read-only remains a capability policy rather than an OS sandbox; Codex adds its native sandbox. None is a confidentiality/offline boundary.

## Installed CLI smoke tests

Preflight validates bounded native model-selector syntax and a deliberately static current effort vocabulary. Claude Code's zero-inference initialize response is used to resolve aliases at selected startup, but account entitlement can still fail after selection; that failure does not fall through. Codex 0.145's generated `ReasoningEffort` schema remains an open string, so the adapter documents and permits only `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; delegation-enabling/unknown values remain excluded. Codex disables provider fallback and verifies the exact model returned by `thread/start` before issuing a turn.

Harness preparation is failure-atomic after its unique private directory is created: write/sync/chmod/auth/config failures remove partial state. Unconfirmable removal returns `harness_cleanup_unconfirmed` and leaves the already-private state fail-closed for inspection rather than claiming deletion.

Normal tests use fixture processes and never spend model tokens. The optional installed-CLI smoke runs executable/auth/harness, official Claude initialize/native-init/MCP inventory checks for both read-only and strict writer policy, and Codex thread initialization. Its Claude initialization input sets `shouldQuery:false`; no model inference or turn occurs:

```bash
PI_SUBAGENTS_REAL_CLI_SMOKE=1 pnpm --filter pi-subagents exec vitest run tests/local-cli-smoke.test.ts
```

The separately gated Herdr smoke creates session-owned topology and starts each native interactive runtime, waits only for private helper readiness, then immediately closes it **without submitting a prompt**. It can still trigger native startup network/auth activity and must not be run against valuable Herdr topology. Supply all three native model selectors:

```bash
PI_SUBAGENTS_REAL_HERDR_SMOKE=1 \
PI_SUBAGENTS_HERDR_PI_MODEL=openai-codex/gpt-5.6-sol \
PI_SUBAGENTS_HERDR_CLAUDE_MODEL=claude-opus-5 \
PI_SUBAGENTS_HERDR_CODEX_MODEL=gpt-5.6-codex \
pnpm --filter pi-subagents exec vitest run tests/herdr-real-smoke.test.ts
```

Paid six-adapter inference is a separate manual gate and is never part of normal CI. The design runs one self-reporting read-only task through `local|herdr × pi|claude|codex`, verifies a supervisor-owned report, then closes every run. It requires explicit cost acknowledgement and a disposable project/Herdr session:

```bash
PI_SUBAGENTS_REAL_INFERENCE_SMOKE=1 PI_SUBAGENTS_REAL_INFERENCE_ACK=paid-and-destructive \
pnpm --filter pi-subagents exec vitest run tests/six-adapter-inference-smoke.test.ts
```

## Cross-process writer safety

Writer cwd is resolved with `realpath` for launch and diagnostics, then identified by the directory's stable local filesystem device plus inode/file ID. The bounded SHA-256 identity digest keys both the in-memory guard and `<agent-dir>/subagents/writer-leases-v2/`; a directory rename therefore cannot evade ownership. Project files receive no lock, receipt, or report artifact. Windows writer starts fail with typed `unsupported_safe_writer_ownership` before canonicalization, lease acquisition, or spawn because safe descendant ownership requires a Job Object implementation. Read-only starts remain available.

A newly acquired lease is `reserved`. Before every initial or respawn driver call, the service must token-check it and durably commit atomic `spawn-started` evidence. Mark failure or ambiguity means the driver is not invoked. Bounded schema-decoded evidence includes the phase, unguessable token, filesystem-identity digest, parent PID, process/session nonce and start evidence, session/run identity, version, and timestamps.

Positive parent death (`ESRCH`) permits automatic reclaim **only** for stably decoded `reserved` evidence. A detached local child or Herdr PTY can outlive its parent, so `spawn-started` is never reclaimed automatically. Corrupt, transitional, permission-denied, changing, or otherwise uncertain evidence is also never overwritten. For those cases, first independently verify that every external backend descendant is dead, then recover the private lease state manually. The extension intentionally makes no automatic crash-cleanup claim for spawn-started writers.

Dead-reservation takeover and normal release both atomically rename the complete lease directory to the **same** deterministic, non-empty destination derived only from the old ownership token, then token-check moved evidence. Release never performs read-then-unlink/rmdir. The shared enduring destination prevents a duplicate or delayed release or takeover from moving a replacement lease after either kind of ABA cycle. Tombstones remain under private agent state; each contains bounded evidence, retained history grows linearly with released/reclaimed ownership tokens, and automatic garbage collection is intentionally absent because delayed-operation death cannot be proven.

Portable PID reuse detection is imperfect. A reused PID is treated as live/uncertain and may conservatively block a writer; process-start evidence and unguessable nonces improve diagnostics but never justify takeover. The protocol assumes same-host Pi parents share one agent directory on a local filesystem with stable device/inode identity and atomic directory create/rename behavior. Distinct agent homes, distributed hosts, and filesystems without those semantics are outside the coordination domain.

Backend/process cleanup must confirm before lease release is authorized. If backend cleanup or tombstone release cannot be confirmed, session quarantine remains. Graceful session shutdown closes each backend before release. An uncatchable parent termination after `spawn-started` leaves a deliberate manual-recovery lock, even if the surviving backend later exits.
