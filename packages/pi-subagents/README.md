# pi-subagents

Session-scoped, profile-routed background subagents for Pi.

## Implemented behavior

- Seven built-in profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `generalist`.
- `subagent_start` accepts one required `agents` array (1–12 items). Each item contains only `task`, optional `profile`, and optional `name`.
- Start is always background and nonblocking. Launch independent workstreams early and continue working; unclaimed successful reports and terminal failures are delivered automatically through one coalesced outcome channel. Use `subagent_await` with `all_finished` or `any_finished` only when progress or final synthesis depends on selected reports.
- Version-4 profile routes own host, runtime, model, effort, context, write intent, OpenAI fast mode, and report-close behavior. Native selectors use one fail-closed 256-character grammar across config, settings, and all six adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, including Pi registry context variants such as `cursor/gpt-5.5@1m`, plus Claude's optional exact long-context suffix such as `[1m]`.
- Ordered candidates receive bounded readiness preflight before run, lease, supervisor, or process ownership. Unavailable executables, unauthenticated CLIs, unsupported fresh/context/effort/write-policy combinations, and missing private-harness prerequisites become typed skips, allowing fallback to a later candidate.
- Once `SubagentService.start` begins, routing never falls through to another candidate; spawn or later outcome uncertainty is surfaced on that selected run and is never retried arbitrarily.
- A single shared backend registry implements all six `local|herdr` × `pi|claude|codex` adapters. Herdr 0.8 selection is pinned to Pi's inherited `HERDR_SOCKET_PATH`; a missing live inherited socket fails readiness before private harness or topology ownership.
- Local Pi children support fresh context and native fork context, read-only inspection/validation tools including Bash or full writer tools, parent contact, guidance, interruption, resume, rename, stop, and bounded completion delivery. Their private run directories remain only while completion is resumable; failure, stop, eviction, or session end reclaims them after process cleanup.
- Local Claude Code uses the current print/SDK stream protocol: official `initialize` control, a zero-inference `shouldQuery:false` native-init probe, validated native model/session/cwd, mandatory connected supervisor MCP inventory, replay-confirmed input, and a correlated interrupt lifecycle. Interruption waits for the exact control response, replayed `[Request interrupted by user]`, and `error_during_execution`/`aborted_streaming` result in either order; unrelated failures remain failures. Its actual capabilities are steer, interrupt, and parent contact.
- Local Codex uses the generated 0.145 app-server v2 stdio JSON-RPC subset (`initialize`, `thread/start`, `turn/start`, `turn/steer`, and `turn/interrupt`) rather than terminal scraping. It uses a private `CODEX_HOME`, copies bounded validated auth from a safe custom source `CODEX_HOME` or the default source without forwarding that source path, otherwise uses the fixed API-key fallback, and enforces approval `never`, disabled web/tool-sandbox network, read-only/workspace-write sandbox policy, and fresh context only. Its actual capabilities are steer, interrupt, and parent contact.
- The backend contract includes bounded report events correlated by run and monotonic assignment epoch, with adapter-owned sequence plus `deliveryId` retry identity. Reports are committed only in the matching issued assignment phase and are in-memory protocol data, never project files.
- Local and Herdr Claude/Codex use a scoped, authenticated loopback `SupervisorChannel` and packaged concurrent stdio MCP helper. Herdr Pi loads one packaged private bridge extension/client exposing the same four tools through `pi-code-previews`; after Pi fully settles, that bridge promotes a successful final response through the same authenticated report channel only when no explicit report was accepted. The channel carries bounded progress, warnings, one correlated blocking question per assignment, and idempotent report delivery without project report files. Ordinary warnings update parent-visible status/session history; the latest child warning and latest system warning are folded together into the terminal outcome, and warnings never create standalone parent model turns.
- `closeOnReport: false` has backend-neutral retained lifecycle semantics: a report finishes the current assignment as `reported`, increments `reportGeneration`, and keeps the read-only backend resource available for guidance and later report generations. Await owns the current/next outcome generation with one exclusive cancellation-safe token; competing awaits fail with `completion_claim_conflict`, competing status redacts the report, and unclaimed reports or failures are delivered once by `(runId, generation)`.
- History is capped at 50 total records and each retained run at 64 unresolved outcome generations. Start rejects with `history_outbox_capacity` instead of exceeding the total bound when unresolved delivery or cleanup prevents eviction.
- At most one writer owns the same stable local directory identity (device + inode/file ID) across same-host parent Pi processes using the shared private agent directory, independent of backend driver. Symlink/relative aliases and directory renames collide; read-only runs acquire no lease. Failed, transitional, or uncertain ownership remains fail-closed on disk and quarantined in session.
- Every extension-owned tool is rendered through the cooperative `pi-code-previews` shell. Tool calls use bounded user-facing action/task/message summaries; results use persisted semantic route/run/action cards with IDs, safety intent, retention, timing/activity, humanized usage, mixed-target recovery, report previews, and explicit omission evidence. Every tool-card model route uses compact `model:effort ⚡` notation when its candidate uses OpenAI priority service.

All six adapters are self-contained. Herdr runs are owned by the current parent Pi session. The parent creates one private shared Herdr workspace/tab for its cwd, records exact pane/terminal/agent/native-session evidence, closes only revalidated owned topology, and never adopts restored native sessions. `closeOnReport:false` retains only read-only panes for later assignments in the same parent session. Writers always close and use the same parent-owned canonical-cwd lease as local writers.

For Claude and Codex, supervisor MCP report delivery—not raw final CLI text—owns completion. Local candidates always close on report, and process scope closes before writer lease release. Supervisor progress, warning, exact correlated question/reply, and report identities/sequences are forwarded unchanged into the backend event queue; warning events update projection/history only, questions steer immediately, and reports or failures use the coalesced outcome notifier. Claude stream input is accepted only after native replay confirmation (the CLI may apply guidance at its next safe turn boundary). Claude interruption includes `cancel_queued:true`. Codex interruption waits for both the correlated JSON-RPC success and matching `turn/completed(status=interrupted)` in either order and emits no later settlement event. Normal Claude and Codex completion both use exact-epoch causal `SupervisorChannel` acceptance evidence recorded before the MCP call is acknowledged, so an accepted report wins even while its queue event is behind progress and a missing/wrong-epoch report fails instead of hanging; Claude's epoch-zero native initialization result remains non-assignment evidence. Resume, rename, peer notice, fork, and retained local runs are not advertised.

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

Each start item accepts exactly `task`, optional `profile`, and optional `name`. Unknown launch fields are rejected, and all starts use the single background execution contract.

Use `subagent_models` to inspect complete configured candidates and static eligibility; executable/auth/harness readiness is checked at launch. It does not claim unsupported backends are available. Successful reports and terminal failures that are not claimed by an await are delivered automatically; ordinary warnings stay in status/history and are included with the eventual outcome rather than starting their own turns. Use `subagent_await` only at a dependency or synthesis barrier, and use it rather than polling status; “finished” means the selected run's current assignment is `reported` or terminal, not necessarily that a retained host resource closed. A parent question returns early so the parent can call `subagent_reply` and await again. For a future retained run, `subagent_send` from `reported` begins the next assignment on the same backend resource; `resume` remains for paused or closed completed sessions where supported.

## Commands and tools

- `/subagents` opens the responsive TUI fleet inspector. In navigation mode, `j/k` move, `h/l` switch list/detail focus, `Ctrl-U` / `Ctrl-D` scroll, `gg/G` jump to endpoints, and `q` closes; arrows and configured Pi selection bindings remain available. Run actions are `m` guide/reply/new task, `i` interrupt, `r` resume, `n` rename, `x` stop, and `t` technical details; unavailable actions explain the capability or state constraint. Guidance, parent replies, next assignments, resume messages, and renames use visible text-input mode, where printable Vim keys remain ordinary text. Action errors remain visible while browsing until another action replaces them; stop confirmation is modal. Narrow lists move by half a viewport with `Ctrl-U` / `Ctrl-D` and show their visible range, while duplicate display names include run IDs.
- `/subagents profiles` opens the full ordered version-4 route editor in Global scope; `/subagents profiles session|global|project` opens a specific scope. It uses the same `j/k`, `h/l`, `Ctrl-U` / `Ctrl-D`, `gg/G`, and `q` navigation; `s` cycles Session → Global → trusted Project scope, while `/` enters an explicit search mode that keeps printable Vim keys typeable. It refreshes Pi's authenticated model catalog before constructing the workspace, falling back to the last coherent snapshot with a warning if refresh fails. It can inspect, add (up to 32), edit, clone, move, remove, disable, or reset complete ordered routes. Session edits use revision-checked in-memory state and apply immediately; global/project edits retain optimistic document concurrency and require `/reload`. Candidate editing covers all six host/runtime combinations plus native model, effort, context, write intent, OpenAI fast mode, and report retention. Destructive actions require repeated-key confirmation, invalid intermediates are never committed, and source/shadow notices distinguish active session routes from saved persistent settings.
- Agent tools: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, and `subagent_rename`. Collapsed cards prioritize the requested action, outcome, route/safety identity, and next step; expanded cards add full IDs, wrapped provenance/capabilities, profile-candidate reasons, and preserved reports/errors. `subagent_models` renders effective route source and static eligibility separately from launch-time checks.

Read-only Pi exposes Bash for inspection and validation while withholding direct `edit`/`write` tools. This is a behavioral tool policy, not a filesystem sandbox or confidentiality boundary: Bash can technically mutate files, does not acquire the writer lease, and must not be used for intentional project changes or destructive commands. Every local Claude launch requires the current strict subprocess sandbox (`enabled`, `failIfUnavailable`, no unsandboxed fallback), an empty network allowlist with strict denial, and explicit filesystem write policy. Both read-only and writer routes expose Bash only through sandbox auto-allow; read-only explicitly denies Bash writes to the assigned cwd, while a writer allows that cwd, omits Write/NotebookEdit, and grants Edit only through a canonical-cwd-scoped current permission pattern. Bare Bash/Edit/Write never appear in `allowedTools` or `permissions.allow`. Unsupported Bash-sandbox platforms fail with `claude_shell_confinement_unsupported`, unsupported writer paths fail with `claude_writer_confinement_unsupported`, and unavailable sandbox dependencies fail selected startup rather than running unsandboxed.

Claude's OS sandbox directly confines Bash and is the stronger boundary. Edit is a separate Claude file-tool permission policy, not a sandboxed subprocess; this adapter depends on the current CLI's scoped-path and symlink enforcement and does not claim a general OS boundary for file tools. Explicit WebFetch/WebSearch and model traffic are also outside the Bash network sandbox, so this is not a confidentiality/offline guarantee. Claude `--safe-mode` is not used because it removes the required stdio MCP path; empty setting sources, strict MCP, fixed tools, and validated native MCP inventory retain that helper while admin-managed policy can still apply. Codex uses its native read-only/workspace-write sandbox, while the adapter-owned supervisor MCP helper intentionally runs outside it. Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.

## Herdr host ownership and harnesses

Herdr candidates accept only the profile's native model/effort/context/write values. The CLI executable is fixed to `herdr`; no profile/config/session selector, executable, argv, or environment is accepted. Composition captures one bounded immutable parent environment for both CLI and harness services. Commands require that snapshot's `HERDR_SOCKET_PATH`, which is also preserved into the sterile native harness so lifecycle hooks report to the same live server; custom native config homes come from the same snapshot. Herdr Pi starts with extension discovery disabled, so models from extension-registered providers are omitted from its picker and rejected again before auth or topology ownership; local Pi remains eligible because its child loads discovered extensions. Herdr 0.8 protocol 19, a matching live-server snapshot, current Pi/Claude/Codex integration markers (8/7/7), canonical executables, auth, effort/model syntax, write policy, and private bridge files are checked before topology is created. A readiness failure may skip to the next candidate. Any mutation timeout, launch uncertainty, or cleanup uncertainty after ownership begins is fail-closed and never falls through.

The parent session lazily creates one non-focusing project workspace/tab. Before every focus, activation, environment, secret, or start mutation, fresh snapshots revalidate the exact workspace/tab/pane/terminal tuple and reject mismatched occupancy; shell process inspection is bracketed by the same ownership check. The host focuses the owned tab only while focus still matches the launch evidence, waits until the new pane has an available unoccupied shell rather than a transient restored native TUI, and causally confirms a harmless random marker; because Herdr 0.8 can drop the first accepted input in a never-focused workspace after session restore, one distinct harmless probe may be retried after refocusing. The caller's prior tab is restored only while its original tab/workspace/label tuple still exists and the owned tab still holds focus, so ID reuse, rollback, or closure never overwrites newer user focus. The host records workspace, tab, pane, terminal, name/runtime, cwd evidence, and every available native `agent_session` field (`source`, `agent`, `kind`, and `value`). Generated agent names satisfy Herdr 0.8's strict `[a-z][a-z0-9_-]{0,31}` contract and include a bounded ownership digest so long parent/run IDs remain distinct. Protocol 19 exposes no launch token that can bind delayed session evidence to the process started originally, so launch requires the full native-session tuple atomically in the `agent start` result; missing identity quarantines the provisional occupant instead of adopting a possible replacement. One comparator revalidates the final full tuple for prompt, inspect, rollback, and close; an incompletely proven provisional occupant is quarantined rather than closed. Every provisional mismatch source—including create/split selector reuse, process-info disagreement, snapshot drift, mismatched start evidence, and pre-commit focus validation—is sticky for that launch. A committed run becomes permanently quarantined after any ownership mismatch or cleanup uncertainty, so later ABA-looking snapshots cannot authorize adoption, repeated close, or cleanup. Automatic operations restore prior tab focus only under the non-stealing predicate above. Confirmed report with `closeOnReport:true`, explicit stop, session replacement/tree navigation/reload, and shutdown close exact owned topology; cleanup is acknowledged and private harness state released only after workspace/tab/pane/terminal/agent-name selectors are all absent. Retained read-only panes remain only until that same parent session ends.

All native harnesses replace the pane shell with a fixed `env -i` environment before startup. Random bounded output markers are matched against bounded recent PTY history and causally confirm both that transition and any private secret bootstrap before `agent start`; secret commands and markers are an atomic pair. Because the environment marker precedes its final shell `exec`, a harmless queued command must execute in the replacement shell before private secret input; the same causal input proof runs after secret bootstrap, followed by read-only process/snapshot checks before agent start. This eliminates marker/`exec` and shell-builtin races without retrying agent start. A bounded readiness miss rolls back exact provisional topology, and Herdr's confirmed pre-application `agent_pane_busy` rejection is likewise safe to roll back. Fixed sleeps are not treated as execution evidence. Multiline supervisor prompts are written to 0600 private files so Herdr 0.8's control-free native-argument contract is preserved. The sole Herdr lifecycle integration is marker- and version-validated and explicitly installed into generated private state. The POSIX harness fails every Windows Herdr candidate during topology-free readiness until a native PowerShell/Job Object owner exists:

- **Claude:** fixed model/effort, read-only Bash inspection inside the current strict subprocess sandbox, empty normal setting sources, `--no-session-persistence`, disabled nonessential traffic in generated settings, strict supervisor MCP, delegation/integration denylist, and cwd-scoped writer Edit policy. Writer cwd characters that cannot be represented safely in the comma-delimited allowed-tool/scoped-Edit grammar are rejected before lease or topology ownership. This disables Claude's resumable conversation transcript/history for the delegated session and the package writes no report/history file in the project. Exact limit: the inherited authenticated Claude installation may still maintain implementation-defined account, cache, diagnostic, or provider-side records outside the project; this is not an offline or zero-retention guarantee. Read-only retention is supported; writers always close.
- **Codex:** isolated private `CODEX_HOME`, bounded recursive `auth.json` copy or API-key fallback loaded from a 0600 private script (never secret argv/diagnostics), strict supervisor-only config, approvals `never`, optional `service_tier = "priority"` with only Codex's `fast_mode` feature enabled for that candidate, read-only/workspace-write sandbox, and web/apps/plugins/multi-agent/network extras disabled. Only read-only runs may be retained.
- **Pi:** fresh private session directory, fixed model/thinking, `PI_SUBAGENT_CHILD=1`, optional private fast-mode request injection of `service_tier: "priority"`, no discovered extensions/skills/prompts/themes/context, Bash-enabled read-only inspection or full writer built-ins, orchestration denylist, marker-validated Herdr lifecycle extension, and one packaged supervisor bridge extension. The private supervisor policy is appended to Pi's default coding prompt. Read-only Pi Bash is prompt-constrained rather than filesystem-sandboxed. Environment-sourced model API keys are resolved before ownership and cross only through the 0600 private bootstrap consumed by that bridge; provider environment is never forwarded wholesale. Its four bridge tools use `withCodePreviewShell`, strict bounded inputs, concurrent correlated helper calls, and exact question replies. The fixed leading assignment-epoch marker resets report state even when a retained prompt is steered into an active Pi loop without another `before_agent_start`. The first possibly delivered report identity is locked for that epoch; a successfully settled response retries only that exact uncertain identity or submits one fallback, explicit acceptance suppresses it, and aborted/error turns or shutdown never promote or retry partial text.

A successful Herdr 0.8 `agent prompt` response proves only ownership-checked text queueing and delayed-Enter scheduling—not submission or execution. Initial and retained follow-up assignments emit `run_started` only after a causal accepted epoch report or bounded post-response lifecycle/state change; absent evidence fails closed. Because active-turn guidance has no equally confirmable application outcome, Herdr drivers advertise only `parent-contact`; `subagent_send` on an already `reported` retained run still begins a new assignment through the separately reconciled start path. Stop and await remain parent service operations. A missing/mismatched agent or native idle/done without an accepted supervisor report fails the run. Pi read-only remains a behavioral capability policy with unsandboxed Bash; Claude and Codex constrain Bash with their native strict read-only sandboxes. None is a confidentiality/offline boundary, and adapter hooks/helpers remain outside model subprocess sandboxes.

## Installed CLI smoke tests

Preflight validates bounded native model-selector syntax and a deliberately static current effort vocabulary. Claude Code's zero-inference initialize response is used to resolve aliases at selected startup, but account entitlement can still fail after selection; that failure does not fall through. Codex 0.145's generated `ReasoningEffort` schema remains an open string, so the adapter documents and permits only `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; delegation-enabling/unknown values remain excluded. Codex disables provider fallback and verifies the exact model returned by `thread/start` before issuing a turn.

Harness preparation is failure-atomic after its unique private directory is created: write/sync/chmod/auth/config failures remove partial state. Unconfirmable removal returns `harness_cleanup_unconfirmed` and leaves the already-private state fail-closed for inspection rather than claiming deletion.

Normal tests use fixture processes and never spend model tokens. The optional installed-CLI smoke runs executable/auth/harness, official Claude initialize/native-init/MCP inventory checks for both read-only and strict writer policy, and Codex thread initialization. Its Claude initialization input sets `shouldQuery:false`; no model inference or turn occurs:

```bash
PI_SUBAGENTS_REAL_CLI_SMOKE=1 pnpm --filter pi-subagents exec vitest run tests/local-cli-smoke.test.ts
```

Every real Herdr smoke requires inherited socket evidence, canonicalizes filesystem aliases, and refuses the inherited socket, Herdr's normal config path (including `XDG_CONFIG_HOME`), and any server whose initial snapshot is non-empty. Provision a separate protocol-19 server with isolated `XDG_CONFIG_HOME` and `XDG_STATE_HOME` (a custom `HERDR_CONFIG_PATH` alone does **not** isolate `session.json`), then pass its socket/config paths explicitly. For example, generate the config and run `herdr server` in a separate terminal with all four environment values pointed under one disposable directory:

```bash
root=/tmp/disposable-herdr
mkdir -p "$root/xdg-config/herdr" "$root/xdg-state"
XDG_CONFIG_HOME="$root/xdg-config" XDG_STATE_HOME="$root/xdg-state" \
HERDR_CONFIG_PATH="$root/xdg-config/herdr/config.toml" \
HERDR_SOCKET_PATH="$root/server.sock" herdr --default-config > "$root/xdg-config/herdr/config.toml"
XDG_CONFIG_HOME="$root/xdg-config" XDG_STATE_HOME="$root/xdg-state" \
HERDR_CONFIG_PATH="$root/xdg-config/herdr/config.toml" \
HERDR_SOCKET_PATH="$root/server.sock" herdr server
```

The no-inference smoke creates session-owned topology, starts each native interactive runtime, waits only for private helper readiness, then immediately closes it **without submitting a prompt**; it can still trigger native startup network/auth activity:

```bash
PI_SUBAGENTS_REAL_HERDR_SMOKE=1 \
PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH=/tmp/disposable-herdr/server.sock \
PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH=/tmp/disposable-herdr/xdg-config/herdr/config.toml \
PI_SUBAGENTS_HERDR_PI_MODEL=openai-codex/gpt-5.6-sol \
PI_SUBAGENTS_HERDR_CLAUDE_MODEL=claude-opus-5 \
PI_SUBAGENTS_HERDR_CODEX_MODEL=gpt-5.6-codex \
pnpm --filter pi-subagents exec vitest run tests/herdr-real-smoke.test.ts
```

The same file has a no-inference real-shell gate that compares `recent` and `recent-unwrapped` with the same long marker on independent disposable workspaces and revalidates exact empty workspace/tab/pane/terminal ownership before cleanup. Both sources passed on an isolated Herdr 0.8 server, so production retains Herdr's default `recent` source rather than treating the stateful #2449 observations as a source-selection result:

```bash
PI_SUBAGENTS_REAL_HERDR_SHELL_SMOKE=1 \
PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH=/tmp/disposable-herdr/server.sock \
PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH=/tmp/disposable-herdr/xdg-config/herdr/config.toml \
pnpm --filter pi-subagents exec vitest run tests/herdr-real-smoke.test.ts
```

A separate paid Herdr assignment gate submits one immediate-report task through Pi, Claude, and Codex, requires an exact cost/destructive acknowledgement, and verifies both `run_started` and a supervisor-owned epoch report before terminating each runtime:

```bash
PI_SUBAGENTS_REAL_HERDR_ASSIGNMENT_SMOKE=1 \
PI_SUBAGENTS_REAL_HERDR_ASSIGNMENT_ACK=paid-and-destructive \
PI_SUBAGENTS_REAL_HERDR_SOCKET_PATH=/tmp/disposable-herdr/server.sock \
PI_SUBAGENTS_REAL_HERDR_CONFIG_PATH=/tmp/disposable-herdr/xdg-config/herdr/config.toml \
PI_SUBAGENTS_HERDR_PI_MODEL=openai-codex/gpt-5.6-sol \
PI_SUBAGENTS_HERDR_CLAUDE_MODEL=claude-opus-5 \
PI_SUBAGENTS_HERDR_CODEX_MODEL=gpt-5.6-codex \
pnpm --filter pi-subagents exec vitest run tests/herdr-real-smoke.test.ts
```

Herdr v0.8 can accept pane input without executing it in a fresh no-focus workspace after session restore. Production now focuses the owned tab and causally attests a harmless random probe before environment or secret input; when the first probe is dropped, it refocuses and tries one distinct harmless probe. If both probes fail, launch stops before private bootstrap or agent start rather than reverting to sleeps or retrying a consequential mutation. Track [herdrdev/herdr#2449](https://github.com/herdrdev/herdr/issues/2449).

Paid six-adapter inference is a separate manual design gate and is never part of normal CI. Assertions must remain backend-specific: Herdr and local Claude/Codex use supervisor-owned reports, while local Pi retains its native settled/final-assistant completion contract. It requires explicit cost acknowledgement and disposable project/Herdr state:

```bash
PI_SUBAGENTS_REAL_INFERENCE_SMOKE=1 PI_SUBAGENTS_REAL_INFERENCE_ACK=paid-and-destructive \
pnpm --filter pi-subagents exec vitest run tests/six-adapter-inference-smoke.test.ts
```

## Cross-process writer safety

Writer cwd is resolved with `realpath` for launch and diagnostics, then identified by the directory's stable local filesystem device plus inode/file ID. The bounded SHA-256 identity digest keys both the in-memory guard and `<agent-dir>/subagents/writer-leases-v2/`; a directory rename therefore cannot evade ownership. Project files receive no lock, receipt, or report artifact. Local Windows writer starts fail with typed `unsupported_safe_writer_ownership` before canonicalization, lease acquisition, or spawn because safe descendant ownership requires a Job Object implementation. All Herdr-hosted candidates currently fail earlier with `herdr_platform_unsupported` because their sterile harness is POSIX-only; local read-only starts remain available.

A newly acquired lease is `reserved`. Before every initial or respawn driver call, the service must token-check it and durably commit atomic `spawn-started` evidence. Mark failure or ambiguity means the driver is not invoked. Bounded schema-decoded evidence includes the phase, unguessable token, filesystem-identity digest, parent PID, process/session nonce and start evidence, session/run identity, version, and timestamps.

Positive parent death (`ESRCH`) permits automatic reclaim **only** for stably decoded `reserved` evidence. A detached local child or Herdr PTY can outlive its parent, so `spawn-started` is never reclaimed automatically. Corrupt, transitional, permission-denied, changing, or otherwise uncertain evidence is also never overwritten. For those cases, first independently verify that every external backend descendant is dead, then recover the private lease state manually. The extension intentionally makes no automatic crash-cleanup claim for spawn-started writers.

Dead-reservation takeover and normal release both atomically rename the complete lease directory to the **same** deterministic, non-empty destination derived only from the old ownership token, then token-check moved evidence. Release never performs read-then-unlink/rmdir. The shared enduring destination prevents a duplicate or delayed release or takeover from moving a replacement lease after either kind of ABA cycle. Tombstones remain under private agent state; each contains bounded evidence, retained history grows linearly with released/reclaimed ownership tokens, and automatic garbage collection is intentionally absent because delayed-operation death cannot be proven.

Portable PID reuse detection is imperfect. A reused PID is treated as live/uncertain and may conservatively block a writer; process-start evidence and unguessable nonces improve diagnostics but never justify takeover. The protocol assumes same-host Pi parents share one agent directory on a local filesystem with stable device/inode identity and atomic directory create/rename behavior. Distinct agent homes, distributed hosts, and filesystems without those semantics are outside the coordination domain.

Backend/process cleanup must confirm before lease release is authorized. If backend cleanup or tombstone release cannot be confirmed, session quarantine remains. Graceful session shutdown closes each backend before release. An uncatchable parent termination after `spawn-started` leaves a deliberate manual-recovery lock, even if the surviving backend later exits.
