# pi-subagents

Session-scoped, profile-routed background subagents for Pi.

## Architecture documentation

- [Architecture and source map](ARCHITECTURE.md)
- [Routing, candidate planning, and launch](docs/routing.md)
- [Local backends and writer ownership](docs/local-backends.md)
- [Herdr topology and ownership](docs/herdr-ownership.md)
- [Completion, projection, and delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)

## Implemented behavior

- Seven built-in profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `generalist`.
- `subagent_start` accepts one required `agents` array (1–12 items). Each item contains `task`, optional `profile`, optional `name`, and optional `writes` with exact workspace-relative file claims. Omitted claims keep a writer exclusive; disjoint claimed writers may share one checkout cooperatively.
- Start is always background and nonblocking. Launch independent workstreams early and continue working; unclaimed successful reports and terminal failures are delivered automatically through one coalesced outcome channel. Use `subagent_await` with `all_finished` or `any_finished` only when progress or final synthesis depends on selected reports.
- Version-4 profile routes own host, runtime, model, effort, context, write intent, OpenAI fast mode, and report-close behavior. Native selectors use one fail-closed 256-character grammar across config, settings, and all six adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, including Pi registry context variants such as `cursor/gpt-5.5@1m`, plus Claude's optional exact long-context suffix such as `[1m]`.
- Ordered candidates receive bounded readiness preflight before run, lease, supervisor, or process ownership. Unavailable executables, unauthenticated CLIs, unsupported fresh/context/effort/write-policy combinations, and missing private-harness prerequisites become typed skips, allowing fallback to a later candidate.
- Once `SubagentService.start` begins, routing never falls through implicitly to another candidate. After a failed run has confirmed cleanup, explicit `subagent_lifecycle` action `retry` creates a linked successor strictly after the selected candidate in the frozen launch-time route. It refuses uncertain execution/cleanup and marks exhaustion before any generalist replacement.
- A single shared backend registry implements all six `local|herdr` × `pi|claude|codex` adapters. Herdr 0.8 selection is pinned to Pi's inherited `HERDR_SOCKET_PATH`; a missing live inherited socket fails readiness before private harness or topology ownership.
- Local Pi children support fresh context and native fork context, read-only inspection/validation tools including Bash or full writer tools, parent contact, guidance, interruption, resume, rename, stop, and bounded completion delivery. Their private run directories remain only while completion is resumable; failure, stop, eviction, or session end reclaims them after process cleanup.
- Local Claude Code uses the current print/SDK stream protocol: official `initialize` control, a zero-inference `shouldQuery:false` native-init probe, validated native model/session/cwd, mandatory connected supervisor MCP inventory, replay-confirmed input, and a correlated interrupt lifecycle. Interruption waits for the exact control response, replayed `[Request interrupted by user]`, and `error_during_execution`/`aborted_streaming` result in either order; unrelated failures remain failures. Its actual capabilities are steer, interrupt, and parent contact.
- Local Codex uses the generated 0.145 app-server v2 stdio JSON-RPC subset (`initialize`, `thread/start`, `turn/start`, `turn/steer`, and `turn/interrupt`) rather than terminal scraping. It uses a private `CODEX_HOME`, copies bounded validated auth from a safe custom source `CODEX_HOME` or the default source without forwarding that source path, otherwise uses the fixed API-key fallback, and enforces approval `never`, disabled web/tool-sandbox network, read-only/workspace-write sandbox policy, and fresh context only. Its actual capabilities are steer, interrupt, and parent contact.
- The backend contract includes bounded report events correlated by run and monotonic assignment epoch, with adapter-owned sequence plus `deliveryId` retry identity. Reports are committed only in the matching issued assignment phase and are in-memory protocol data, never project files.
- Local and Herdr Claude/Codex use a scoped, authenticated loopback `SupervisorChannel` and packaged concurrent stdio MCP helper. Herdr Pi loads one packaged private bridge extension/client exposing the same four tools through `pi-code-previews`; after Pi fully settles, that bridge promotes a successful final response through the same authenticated report channel only when no explicit report was accepted. Bridge calls remain Effects until Pi's Promise tool boundary runs them in the delegated session runtime. Shutdown interrupts and joins active calls before the runtime releases the helper; no client or cleanup handle escapes startup. The channel carries bounded progress, warnings, one correlated blocking question per assignment, and idempotent report delivery without project report files. Ordinary warnings update parent-visible status/session history; the latest child warning and latest system warning are folded together into the terminal outcome, and warnings never create standalone parent model turns.
- `closeOnReport: false` has backend-neutral retained lifecycle semantics: a report finishes the current assignment as `reported`, increments `reportGeneration`, and keeps the read-only backend resource available for guidance and later report generations. Each run's `completionGenerations` map is the sole completion payload/outbox. Await claims remain separate, including claims made before the next payload exists. Report/terminal commit inserts and wakes under the service lock; the worker scans deterministic unclaimed generations and delivers no more than 12 per batch. Competing awaits fail with `completion_claim_conflict`, competing status redacts the report, and exact acknowledged `(runId, generation)` payloads are removed. Question retry ownership is independent of completion delivery.
- History is capped at 50 total records and every run at 64 unresolved outcome generations. A retained run admits its 63rd unresolved report but rejects another assignment, reserving generation 64 for a later terminal backend failure and never creating generation 65. Close-on-report resume remains bounded below 64. Start rejects with `history_outbox_capacity` instead of exceeding the total history bound when unresolved delivery or cleanup prevents eviction.
- At most one parent session owns the writer pool for the same stable local directory identity (device + inode/file ID) across same-host Pi processes using the shared private agent directory. Within that session, exact pairwise-disjoint claims admit concurrent writers under one first-acquire/last-release lease. Claims coordinate unchanged native edit, write, and Bash tools; they are not per-file filesystem isolation. Likely mutating Bash commands increment a bounded heuristic-notice count without creating sticky run warnings. Symlink/relative cwd aliases and directory renames collide, read-only runs acquire no lease, and uncertain cleanup quarantines the whole pool.
- Every extension-owned tool is rendered through the cooperative `pi-code-previews` shell. `subagent_start` keeps bounded task text expanded-only and ends with an immutable request-ordered launch receipt: every row retains profile plus the actual selected route/model (or an explicit resolving/no-eligible-route state), while live state/tool/timing/usage moves to `/subagents`, list, status, and await surfaces. Mixed launch outcomes use a warning banner, fallback-candidate notes and failure recovery are expanded-only, and successful receipts hand off once to `/subagents` for live status. Persisted details use strict version 2 and one Effect Schema model. Start requires request-ordered entries and stores no run cards; await requires cards plus its wait condition. Makers and decoders strip private or unknown fields, reject malformed known children without partial salvage, deep-freeze their output, and cap canonical serialized details at 48,000 characters. Older history falls back to its bounded terminal-sanitized text instead of reconstructing version-1 cards. Other current results use persisted semantic route/run/action cards with IDs, safety intent, retention, timing/activity, humanized usage, mixed-target recovery, report previews, and explicit omission evidence. Every selected model route uses compact `model:effort ⚡` notation when its candidate uses OpenAI priority service.

All six adapters are self-contained. Herdr runs are owned by the current parent Pi session. A Herdr candidate requires Pi to be running inside one resolvable inherited pane; the first launch splits that calling pane in its current workspace/tab, and later launches split the newest live owned pane there. The parent records exact pane/terminal/agent/native-session evidence, closes only revalidated subagent panes, never closes the calling pane/workspace/tab, and never adopts restored native sessions. `closeOnReport:false` retains only read-only panes for later assignments in the same parent session. Writers always close and use the same parent-owned canonical-cwd lease as local writers.

For Claude and Codex, supervisor MCP report delivery—not raw final CLI text—owns completion. Local candidates always close on report. Each writer process scope closes before its pool membership detaches, and the final confirmed member releases the shared lease. Supervisor progress, warning, exact correlated question/reply, and report identities/sequences are forwarded unchanged into the backend event queue; warning events update projection/history only, questions steer immediately, and reports or failures use the coalesced outcome notifier. Claude stream input is accepted only after native replay confirmation (the CLI may apply guidance at its next safe turn boundary). Claude interruption includes `cancel_queued:true`. Codex interruption waits for both the correlated JSON-RPC success and matching `turn/completed(status=interrupted)` in either order and emits no later settlement event. Normal Claude and Codex completion both use exact-epoch causal `SupervisorChannel` acceptance evidence recorded before the MCP call is acknowledged, so an accepted report wins even while its queue event is behind progress and a missing/wrong-epoch report fails instead of hanging; Claude's epoch-zero native initialization result remains non-assignment evidence. Resume, rename, peer notice, fork, and retained local runs are not advertised.

## Profiles

Each built-in uses one explicit `local` + `pi` + `parent` candidate with `closeOnReport: true`. Profile defaults are:

| Profile      | Context | Write intent | Effort        |
| ------------ | ------- | ------------ | ------------- |
| `scout`      | fresh   | read-only    | low           |
| `researcher` | fresh   | read-only    | medium        |
| `planner`    | fresh   | read-only    | xhigh         |
| `worker`     | fresh   | writer       | high          |
| `reviewer`   | fresh   | read-only    | high          |
| `oracle`     | fork    | read-only    | high          |
| `generalist` | fresh   | read-only    | parent effort |

Omitting `profile` always selects `generalist`; specialized profiles must be explicit. Configuration and tool inputs accept only the seven profile IDs listed above.

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

Unknown root or candidate keys invalidate the document or complete present route and fail closed. Persistent precedence is trusted project over global over built-in. A temporary session override, when present, replaces that profile's complete loaded route above every persistent layer. Removed policy fields (`denied` and `discouraged`) and execution/lifetime fields are not part of v4 and produce unknown-key diagnostics.

Only version 4 is accepted. Every other version fails activation; configuration is never migrated or normalized from an earlier shape.

### Temporary session overrides

`/subagents profiles session` opens the same ordered route editor in an in-memory Session scope. Press `s` to cycle Session → Global → Project; untrusted projects cycle only Session ↔ Global. Editing an inherited session route copies the complete currently active route before applying the selected change, so changing only one candidate model preserves fallback order and every safety field. Session changes apply immediately to new launches and `subagent_models`; active runs keep their admitted route. `i` clears the selected profile override and `X` clears every session override after confirmation.

Session overrides write no project, global, or Pi session-history data. They survive `/tree` navigation and `/reload`; reload refreshes the persistent base configuration and then reapplies the complete session routes. They clear on `/new`, `/resume`, `/fork`, quit, or process restart. Clearing an override reveals the persistent configuration loaded by the latest activation. Precedence is Session > trusted Project > Global > Built-in.

## Starting and waiting

For substantial work, first check whether the task contains at least two independent workstreams. Launch one to three bounded read-only assignments early in one batch, then continue the main agent's independent work. Good delegation candidates include unfamiliar or multi-package codebase reconnaissance, external research that can run beside local inspection, implementation planning, and independent review. Skip delegation for trivial or tightly serial tasks.

Prefer `scout`, `researcher`, `planner`, `reviewer`, and `oracle` for parallel read-only work. Use `worker` only for explicit implementation handoffs. While any writer pool is active, the main agent coordinates and reviews but does not edit. A claimless worker is exclusive; multiple workers require pairwise-disjoint exact `writes` paths.

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

Each start item accepts `task`, optional `profile`, optional `name`, and optional `writes`. `writes` contains 1–64 normalized exact workspace-relative POSIX file paths and is valid only for a profile that resolves to writer intent. Unknown launch fields are rejected, and all starts use the single background execution contract.

For cooperative parallel implementation in one checkout:

```json
{
  "agents": [
    {
      "task": "Implement token parsing in the assigned source and test files.",
      "profile": "worker",
      "writes": ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"]
    },
    {
      "task": "Implement typed authentication errors in the assigned file.",
      "profile": "worker",
      "writes": ["packages/auth/src/errors.ts"]
    }
  ]
}
```

These paths prevent overlapping admission and guide coordination, but they do not restrict what native tools or Bash can physically mutate.

Use `subagent_models` to inspect complete configured candidates and static eligibility; executable/auth/harness readiness is checked at launch. It does not claim unsupported backends are available. Successful reports and terminal failures that are not claimed by an await are delivered automatically; ordinary warnings stay in status/history and are included with the eventual outcome rather than starting their own turns. When a failed notification says candidates remain, call `subagent_lifecycle({ action: "retry", runIds: [...] })` before launching a generalist replacement. Retry preserves the original task/profile and advances the frozen route without re-attempting the failed candidate; repeat only on a failed successor, and use generalist only after `retry_route_exhausted`. Use `subagent_await` only at a dependency or synthesis barrier, and use it rather than polling status; “finished” means the selected run's current assignment is `reported` or terminal, not necessarily that a retained host resource closed. A parent question returns early so the parent can call `subagent_reply` and await again. For a future retained run, `subagent_send` from `reported` begins the next assignment on the same backend resource; `resume` remains for paused or closed completed sessions where supported.

## Commands and tools

- `/subagents` opens the responsive TUI fleet inspector. In navigation mode, `j/k` move, `h/l` switch list/detail focus, `Ctrl-U` / `Ctrl-D` scroll, `gg/G` jump to endpoints, and `q` closes; arrows and configured Pi selection bindings remain available. Run actions are `m` guide/reply/new task, `i` interrupt, `r` resume, `n` rename, `x` stop, and `t` technical details; unavailable actions explain the capability or state constraint. Guidance, parent replies, next assignments, resume messages, and renames use visible text-input mode, where printable Vim keys remain ordinary text. Action errors remain visible while browsing until another action replaces them; stop confirmation is modal. Narrow lists move by half a viewport with `Ctrl-U` / `Ctrl-D` and show their visible range, while duplicate display names include run IDs.
- `/subagents profiles` opens the full ordered version-4 route editor in Global scope; `/subagents profiles session|global|project` opens a specific scope. It uses the same `j/k`, `h/l`, `Ctrl-U` / `Ctrl-D`, `gg/G`, and `q` navigation; `s` cycles Session → Global → trusted Project scope, while `/` enters an explicit search mode that keeps printable Vim keys typeable. It opens immediately from one immutable Pi model/provenance snapshot while a cancelable refresh runs in the background; a successful refresh atomically replaces the snapshot, and failure or abort retains the prior generation with a bounded warning. It can inspect, add (up to 32), edit, clone, move, remove, disable, or reset complete ordered routes. Session edits use revision-checked in-memory state and apply immediately; global/project edits retain optimistic document concurrency and require `/reload`. Candidate editing covers all six host/runtime combinations plus native model, effort, context, write intent, OpenAI fast mode, and report retention. Destructive actions require repeated-key confirmation, invalid intermediates are never committed, and source/shadow notices distinguish active session routes from saved persistent settings.
- Agent tools: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, `subagent_rename`, and parent-only `subagent_claims`. The claims tool lists, grants, and revokes exact cooperative ownership while a worker waits on a parent claim question with no other active tool, and resumes writer admission after the parent reviews a detected violation. Lifecycle action `retry` continues failed runs through their remaining frozen profile route with exact predecessor/successor lineage; it is not same-candidate rerun or automatic failover. Start calls keep names/profiles compact and reveal bounded tasks only when expanded; final start cards are immutable launch receipts, not live run cards. Other collapsed cards prioritize the requested action, outcome, route/safety identity, and next step; expanded cards add full IDs, wrapped provenance/capabilities, profile-candidate reasons, and preserved reports/errors. `subagent_models` renders effective route source and static eligibility separately from launch-time checks.

Read-only Pi exposes Bash for inspection and validation while withholding direct `edit`/`write` tools. This is a behavioral tool policy, not a filesystem sandbox or confidentiality boundary: Bash can technically mutate files, does not acquire the writer lease, and must not be used for intentional project changes or destructive commands. Every local Claude launch requires the current strict subprocess sandbox (`enabled`, `failIfUnavailable`, no unsandboxed fallback), an empty network allowlist with strict denial, and explicit filesystem write policy. Both read-only and writer routes expose Bash only through sandbox auto-allow; read-only explicitly denies Bash writes to the assigned cwd, while a writer allows that cwd, omits Write/NotebookEdit, and grants Edit only through a canonical-cwd-scoped current permission pattern. Bare Bash/Edit/Write never appear in `allowedTools` or `permissions.allow`. Unsupported Bash-sandbox platforms fail with `claude_shell_confinement_unsupported`, unsupported writer paths fail with `claude_writer_confinement_unsupported`, and unavailable sandbox dependencies fail selected startup rather than running unsandboxed.

Claude's OS sandbox directly confines Bash and is the stronger boundary. Edit is a separate Claude file-tool permission policy, not a sandboxed subprocess; this adapter depends on the current CLI's scoped-path and symlink enforcement and does not claim a general OS boundary for file tools. Explicit WebFetch/WebSearch and model traffic are also outside the Bash network sandbox, so this is not a confidentiality/offline guarantee. Claude `--safe-mode` is not used because it removes the required stdio MCP path; empty setting sources, strict MCP, fixed tools, and validated native MCP inventory retain that helper while admin-managed policy can still apply. Codex uses its native read-only/workspace-write sandbox, while the adapter-owned supervisor MCP helper intentionally runs outside it. Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.

## Herdr host ownership and harnesses

Herdr candidates accept only the profile's native model/effort/context/write values. The CLI executable is fixed to `herdr`; no profile/config/session selector, executable, argv, or environment is accepted. Composition captures one bounded immutable parent environment for both CLI and harness services. Commands require that snapshot's `HERDR_SOCKET_PATH`, `HERDR_ENV=1`, and calling `HERDR_PANE_ID`; the socket is also preserved into the sterile native harness so lifecycle hooks report to the same live server, and custom native config homes come from the same snapshot. Herdr Pi starts with extension discovery disabled, so models from extension-registered providers are omitted from its picker and rejected again before auth or topology ownership; local Pi remains eligible because its child loads discovered extensions. Herdr 0.8 protocol 19, a matching live-server snapshot, an exact `pane current --current` result, current Pi/Claude/Codex integration markers (8/7/7), canonical executables, auth, effort/model syntax, write policy, and private bridge files are checked before topology mutation. A missing or unresolvable calling pane and other safe readiness failures may skip to the next candidate. Any mutation timeout, launch uncertainty, or cleanup uncertainty after ownership begins is fail-closed and never falls through.

Each launch re-resolves the calling Pi pane against a fresh snapshot. The first run in that workspace/tab splits the caller with `--no-focus`; later runs split the newest live owned subagent pane in the same current workspace/tab, so the parent pane is divided only once per tab. If the caller moves to another tab, that tab receives its own chain. Before every focus, activation, environment, secret, or start mutation, fresh snapshots revalidate the exact workspace/tab/pane/terminal tuple and reject mismatched occupancy; shell process inspection is bracketed by the same ownership check. Active/focused tab changes do not quarantine committed runs. The host focuses the target tab only while focus still matches launch evidence, waits until the new pane has an available unoccupied shell rather than a transient restored native TUI, and causally confirms a harmless random marker; one distinct harmless probe may be retried after refocusing. It then waits again without input when agent detection briefly lags behind process-info's exact foreground-shell evidence, continuing only after both bounded sources agree that the provisional pane is unoccupied. The caller's prior tab is restored only while its original tab/workspace/label tuple still exists and the target tab still holds focus, so ID reuse, rollback, or closure never overwrites newer user focus. The host records workspace, tab, pane, terminal, name/runtime, cwd evidence, and every available native `agent_session` field (`source`, `agent`, `kind`, and `value`). Generated agent names satisfy Herdr 0.8's strict `[a-z][a-z0-9_-]{0,31}` contract and include a bounded ownership digest so long parent/run IDs remain distinct. Protocol 19 exposes no launch token that can bind delayed session evidence to the process started originally, so launch requires the full native-session tuple atomically in the `agent start` result; missing identity quarantines the provisional occupant instead of adopting a possible replacement. One comparator revalidates the final full tuple for prompt, inspect, rollback, and close; an incompletely proven provisional occupant is quarantined rather than closed. Every provisional mismatch source—including split selector reuse, process-info disagreement, snapshot drift, mismatched start evidence, and pre-commit focus validation—is sticky for that launch. A committed run becomes permanently quarantined after any ownership mismatch or cleanup uncertainty, so later ABA-looking snapshots cannot authorize adoption, repeated close, or cleanup. Automatic operations restore prior tab focus only under the non-stealing predicate above. Confirmed report with `closeOnReport:true`, explicit stop, session replacement/tree navigation/reload, and shutdown close only exact owned subagent panes; the calling pane, tab, and workspace are never targeted. Closure is refused if no sibling pane remains, avoiding a known tab/workspace collapse after the caller disappears. Cleanup is acknowledged and private harness state released only after pane/terminal/agent-name/native-session selectors are all absent. Retained read-only panes remain only until that same parent session ends.

All native harnesses replace the pane shell with a fixed `env -i` environment before startup. Random bounded output markers are matched against bounded recent PTY history and causally confirm both that transition and any private secret bootstrap before `agent start`; secret commands and markers are an atomic pair. Because the environment marker precedes its final shell `exec`, a harmless queued command must execute in the replacement shell before private secret input; the same causal input proof runs after secret bootstrap, followed by read-only process/snapshot checks before agent start. This eliminates marker/`exec` and shell-builtin races without retrying agent start. A bounded readiness miss rolls back exact provisional topology, and Herdr's confirmed pre-application `agent_pane_busy` rejection is likewise safe to roll back. Fixed sleeps are not treated as execution evidence. Multiline supervisor prompts are written to 0600 private files so Herdr 0.8's control-free native-argument contract is preserved. The sole Herdr lifecycle integration is marker- and version-validated and explicitly installed into generated private state. The POSIX harness fails every Windows Herdr candidate during mutation-free readiness until a native PowerShell/Job Object owner exists:

- **Claude:** fixed model/effort, read-only Bash inspection inside the current strict subprocess sandbox, empty normal setting sources, `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` in the sterile process environment, disabled nonessential traffic in generated settings, strict supervisor MCP, delegation/integration denylist, and cwd-scoped writer Edit policy. Current interactive Claude rejects the print-only `--no-session-persistence`; its documented environment replacement suppresses prompt-history and session-transcript writes while preserving inherited native authentication. Writer cwd characters that cannot be represented safely in the comma-delimited allowed-tool/scoped-Edit grammar are rejected before lease or topology ownership. Such delegated sessions are absent from resume/continue/up-arrow history and the package writes no report/history file in the project. The inherited installation may still maintain implementation-defined account, cache, diagnostic, or provider-side records; this is not an offline or zero-retention guarantee. Read-only retention is supported; writers always close.
- **Codex:** isolated private `CODEX_HOME`, bounded recursive `auth.json` copy or API-key fallback loaded from a 0600 private script (never secret argv/diagnostics), strict supervisor-only config, approvals `never`, optional `service_tier = "priority"` with only Codex's `fast_mode` feature enabled for that candidate, read-only/workspace-write sandbox, and web/apps/plugins/multi-agent/network extras disabled. Before topology mutation, the exact generated startup hook is discovered with native `hooks/list`, only its opaque current hash is trusted through `config/batchWrite`, and a second listing must confirm the same hook as trusted. A fixed startup prompt runs the marker-validated integration through a packaged nullable-transcript compatibility helper whose `continue:false` result stops the bootstrap turn before inference while returning atomic native-session evidence to Herdr. Only read-only runs may be retained.
- **Pi:** fresh private session directory, fixed model/thinking, `PI_SUBAGENT_CHILD=1`, optional private fast-mode request injection of `service_tier: "priority"`, no discovered extensions/skills/prompts/themes/context, Bash-enabled read-only inspection or full writer built-ins, orchestration denylist, marker-validated Herdr lifecycle extension, and one packaged supervisor bridge extension. The private supervisor policy is appended to Pi's default coding prompt. Read-only Pi Bash is prompt-constrained rather than filesystem-sandboxed. Environment-sourced model API keys are resolved before ownership and cross only through the 0600 private bootstrap consumed by that bridge; provider environment is never forwarded wholesale. Its four bridge tools use `withCodePreviewShell`, strict bounded inputs, concurrent correlated helper calls, and exact question replies. The fixed leading assignment-epoch marker resets report state even when a retained prompt is steered into an active Pi loop without another `before_agent_start`. The first possibly delivered report identity is locked for that epoch; a successfully settled response retries only that exact uncertain identity or submits one fallback, explicit acceptance suppresses it, and aborted/error turns or shutdown never promote or retry partial text.

A successful Herdr 0.8 `agent prompt` response proves only ownership-checked text queueing and delayed-Enter scheduling—not submission or execution. Initial and retained follow-up assignments emit `run_started` only after a causal accepted epoch report or bounded post-response lifecycle/state change; absent evidence fails closed. Because active-turn guidance has no equally confirmable application outcome, Herdr drivers advertise only `parent-contact`; `subagent_send` on an already `reported` retained run still begins a new assignment through the separately reconciled start path. Stop and await remain parent service operations. A missing/mismatched agent or native idle/done without an accepted supervisor report fails the run. Pi read-only remains a behavioral capability policy with unsandboxed Bash; Claude and Codex constrain Bash with their native strict read-only sandboxes. None is a confidentiality/offline boundary, and adapter hooks/helpers remain outside model subprocess sandboxes.

## Native preflight safety

Preflight validates bounded native model-selector syntax and a deliberately static current effort vocabulary. Claude Code's zero-inference initialize response is used to resolve aliases at selected startup, but account entitlement can still fail after selection; that failure does not fall through. Codex 0.145's generated `ReasoningEffort` schema remains an open string, so the adapter documents and permits only `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; delegation-enabling/unknown values remain excluded. Codex disables provider fallback and verifies the exact model returned by `thread/start` before issuing a turn.

Harness preparation is failure-atomic after its unique private directory is created: write/sync/chmod/auth/config failures remove partial state. Unconfirmable removal returns `harness_cleanup_unconfirmed` and leaves the already-private state fail-closed for inspection rather than claiming deletion.

## Cross-process writer safety

Writer cwd is resolved with `realpath` for launch and diagnostics, then identified by the directory's stable local filesystem device plus inode/file ID. The bounded SHA-256 identity digest keys both the in-memory guard and `<agent-dir>/subagents/writer-leases-v2/`; a directory rename therefore cannot evade ownership. Project files receive no lock, receipt, or report artifact. Local Windows writer starts fail with typed `unsupported_safe_writer_ownership` before canonicalization, lease acquisition, or spawn because safe descendant ownership requires a Job Object implementation. All Herdr-hosted candidates currently fail earlier with `herdr_platform_unsupported` because their sterile harness is POSIX-only; local read-only starts remain available.

A newly acquired pool lease is `reserved`. The first pool member token-checks it and durably commits atomic `spawn-started` evidence before any member driver call. Later members share that evidence while the pool remains held. A new pool created for a later respawn performs a fresh acquire and mark. Mark failure or ambiguity means no waiting member invokes its driver. Bounded schema-decoded evidence includes the phase, unguessable token, filesystem-identity digest, parent PID, process/session nonce and start evidence, session/run identity, version, and timestamps.

Positive parent death (`ESRCH`) permits automatic reclaim **only** for stably decoded `reserved` evidence. A detached local child or Herdr PTY can outlive its parent, so `spawn-started` is never reclaimed automatically. Corrupt, transitional, permission-denied, changing, or otherwise uncertain evidence is also never overwritten. For those cases, first independently verify that every external backend descendant is dead, then recover the private lease state manually. The extension intentionally makes no automatic crash-cleanup claim for spawn-started writers.

Dead-reservation takeover and normal release both atomically rename the complete lease directory to the **same** deterministic, non-empty destination derived only from the old ownership token, then token-check moved evidence. Release never performs read-then-unlink/rmdir. The shared enduring destination prevents a duplicate or delayed release or takeover from moving a replacement lease after either kind of ABA cycle. Tombstones remain under private agent state; each contains bounded evidence, retained history grows linearly with released/reclaimed ownership tokens, and automatic garbage collection is intentionally absent because delayed-operation death cannot be proven.

Portable PID reuse detection is imperfect. A reused PID is treated as live/uncertain and may conservatively block a writer; process-start evidence and unguessable nonces improve diagnostics but never justify takeover. The protocol assumes same-host Pi parents share one agent directory on a local filesystem with stable device/inode identity and atomic directory create/rename behavior. Distinct agent homes, distributed hosts, and filesystems without those semantics are outside the coordination domain.

Every member's backend/process cleanup must confirm before it detaches. The final member alone authorizes lease release. If any backend cleanup or tombstone release cannot be confirmed, the entire cwd pool remains quarantined. Graceful session shutdown closes each backend before the final release. An uncatchable parent termination after `spawn-started` leaves a deliberate manual-recovery lock, even if the surviving backend later exits.
