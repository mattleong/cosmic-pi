# pi-subagents

Session-scoped, profile-routed background subagents for Pi.

The 11 coordinator tools and `subagent_workflow` honor Code Previews' opt-in `toolCallCollapsedStyle: "compact"` setting after `/reload`, as do the coordinator tools' local Pi proxies. Ordinary calls show a short state/count summary; expansion restores the existing cards. Reports, parent questions, admission problems, retry recovery, and incomplete results keep their detailed views. Separate child-only supervisor acknowledgements and `contact_parent` are unchanged.

Compact discovery counts statically eligible, disabled, and unavailable routes and options, not launch readiness. Skipped alternatives stay in expanded discovery; invalid configuration and routes without eligible candidates still warn. Clean completed runs show static skip history as a count, while explicit warnings, failed launch evidence, omissions, and recovery remain visible. Successful integration shows uncommitted edits and index preservation as metadata. Empty workspace lists are quiet; nonempty or unknown lists retain orphan-recovery guidance, with pagination offsets in metadata. Expansion keeps original receipts, reasons, IDs, and instructions.

## Architecture documentation

- [Architecture: ownership, boundaries, and lifecycle](ARCHITECTURE.md)
- [Routing, candidate planning, and launch](docs/routing.md)
- [Local backends and writer ownership](docs/local-backends.md)
- [Completion, projection, and delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Dynamic workflows and codemode scripting](docs/workflows.md)
- [Workflow internals](docs/workflow-internals.md)

## Implemented behavior

- The root Pi session is depth 0 and owns the sole coordinator, configuration, run tree, backend registry, writer pools, completion outbox, and all descendant processes. Nested local Pi sessions load packaged private proxy tools and a subtree manager. They do not create independent services or read configuration. The server binds ancestry to each authenticated per-run channel.
- Every run records immutable parent and depth. Defaults allow 12 active direct children per parent through depth 3; configured bounds are 1 through 32 and 0 through 8. Dynamic workflow agents don't count toward the root's direct-child limit; each workflow run has its own concurrency. There is no tree-wide active-run budget. Nested Pi can select any configured profile. The root still enforces writer leases and disjoint claims across the complete tree.
- Natural completion or failure of an intermediate Pi leaves descendants running. Explicit stop closes its subtree leaf-first. Root replacement and shutdown close everything leaf-first. Unclaimed outcomes and questions go to the nearest connected Pi ancestor, then root. Retry successors keep the predecessor parent.
- Seven built-in profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `generalist`.
- `subagent_start` accepts one required `agents` array (1–32 items), subject to the caller's effective direct-child capacity. Each item contains `task`, optional `profile`, optional `name`, and optional `writes` with exact workspace-relative file claims. The persisted session writer mode defaults to `shared-checkout`, with exclusive or disjoint-claim cooperative ownership. Opt-in `worktree` mode gives each writer a separate checkout. There is no per-worker mode override; only dynamic workflow agents can ask for a worktree with `isolation: "worktree"`.
- Start is always background and nonblocking. Launch independent workstreams early and continue working; unclaimed successful reports and terminal failures are delivered automatically through one coalesced outcome channel. Use `subagent_await` with `all_finished` or `any_finished` only when progress or final synthesis depends on selected reports.
- Version-6 configuration groups routes into named profile sets. Global and trusted-project documents use the same shape, select a scope-local `defaultProfileSet`, and layer missing routes over the selected lower-precedence set. Routes own runtime, model, effort, context, write intent, optional OpenAI fast mode, and normal host/report-close behavior. Native selectors use one fail-closed 256-character grammar across config, settings, and all three local adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, including Pi registry context variants such as `cursor/gpt-5.5@1m`, plus Claude's optional exact long-context suffix such as `[1m]`.
- Explicitly declared local candidates receive bounded readiness preflight before run, lease, supervisor, or process ownership. Unavailable executables, unauthenticated CLIs, unsupported context/effort/write-policy combinations, and missing private-harness prerequisites become typed skips, allowing fallback only to a later declared candidate. No remote candidate is converted into a local route.
- Once `SubagentService.start` begins, routing never falls through implicitly to another candidate. After a failed run has confirmed cleanup, explicit `subagent_lifecycle` action `retry` creates a linked successor strictly after the selected candidate in the frozen launch-time route. It refuses uncertain execution/cleanup and marks exhaustion before any generalist replacement.
- A single shared backend registry implements three local drivers: Pi, Claude, and Codex.
- Local Pi children support fresh context and native fork context, the root Pi's launch-time trusted-tool snapshot for either write intent, parent contact, guidance, interruption, resume, rename, stop, and bounded completion delivery. Their private run directories remain only while completion is resumable; failure, stop, eviction, or session end reclaims them after process cleanup.
- Local Claude Code uses the current print/SDK stream protocol: official `initialize` control, a zero-inference `shouldQuery:false` native-init probe, validated native model/session/cwd, mandatory connected supervisor MCP inventory, same-session UUID replay confirmation, narrow ownership of Claude 2.1.259's metadata-deficient internal task-notification queue replay, and a correlated interrupt lifecycle. All near-miss or otherwise unknown replay remains fail closed before report acceptance; after the supervisor proves the exact assignment report was accepted, a trailing unknown replay warns and preserves that report for normal close-on-report settlement. Content matching is diagnostic only. `PI_SUBAGENTS_CLAUDE_DEBUG=1` enables a bounded metadata-only private ledger and is never forwarded to Claude. Interruption waits for the exact control response, replayed `[Request interrupted by user]`, and `error_during_execution`/`aborted_streaming` result in either order; unrelated failures remain failures. Its actual capabilities are steer, interrupt, and parent contact.
- Local Codex uses the generated 0.145 app-server v2 stdio JSON-RPC subset (`initialize`, `thread/start`, `turn/start`, `turn/steer`, and `turn/interrupt`) rather than terminal scraping. It uses a private `CODEX_HOME`, copies bounded validated auth from a safe custom source `CODEX_HOME` or the default source without forwarding that source path, otherwise uses the fixed API-key fallback, and enforces approval `never`, disabled web/tool-sandbox network, read-only/workspace-write sandbox policy, and fresh context only. Its actual capabilities are steer, interrupt, and parent contact.
- The backend contract includes bounded report events correlated by run and monotonic assignment epoch, with adapter-owned sequence plus `deliveryId` retry identity. Reports are committed only in the matching issued assignment phase and are in-memory protocol data, never project files.
- Local Claude/Codex use a scoped, authenticated loopback `SupervisorChannel` and packaged concurrent stdio MCP helper. The local native supervisor bridge carries bounded progress, warnings, one correlated blocking question per assignment, and idempotent report delivery without project report files. Local Pi uses its separate RPC/IPC child bridge. Ordinary warnings update parent-visible status/session history; child and system warnings are folded into the terminal outcome rather than starting standalone parent model turns.
- Every supported launch closes its backend scope after reporting. `closeOnReport` may be omitted or `true`; `false` is unsupported. Completion payloads and exclusive await claims remain in memory after process cleanup. Exact acknowledged `(runId, generation)` payloads are consumed, competing awaits fail with `completion_claim_conflict`, and competing status redacts claimed reports. Supported local Pi resume/respawn creates another assignment generation; it does not retain an idle live process.
- Each run is capped at 64 unresolved outcome generations, including supported close-on-report resume/respawn. The registry reclaims eligible terminal leaves after 50 terminal records, but ancestry, unresolved delivery, and active descendants may require a larger tree. History retention never becomes a hidden tree-wide admission budget.
- At most one parent session owns the writer pool for the same stable local directory identity (device + inode/file ID) across same-host Pi processes using the shared private agent directory. Within that session, exact pairwise-disjoint claims admit concurrent writers under one first-acquire/last-release lease. Claims coordinate unchanged native edit, write, and Bash tools; they are not per-file filesystem isolation. Likely mutating Bash commands increment a bounded heuristic-notice count without creating sticky run warnings. Symlink/relative cwd aliases and directory renames collide, read-only runs acquire no lease, and uncertain cleanup quarantines the whole pool.
- Every extension-owned tool is rendered through the cooperative `pi-code-previews` shell. In TUI mode, one persistent read-only widget above the editor owns the live parent-before-child hierarchy for every working, waiting, paused, starting, or stopping run. It shows all matching rows in stable launch order, keeps terminal ancestors only when needed for tree context, marks active await targets with `◎`, and disappears when only terminal records remain. A static green `Subagents` title anchors the panel while compact progress segments carry start and await mode. A one-column inset keeps hierarchy rails green while await markers, state glyphs, and titles follow each run's state; shared responsive tiers show profile plus a provider-free `model:effort` label below 100 columns, while wide rows keep profile, host/runtime, and the full provider/model route. Optional activity and elapsed metadata use only the remaining space. The footer status is suppressed while the widget has content. `subagent_start` keeps bounded task text expanded-only and ends with an immutable request-ordered launch receipt. Its collapsed result is a summary with exceptional failures or route warnings; expansion reveals every profile and actual selected route/model, or an explicit resolving/no-eligible-route state. Successful start cards keep one call-level tasks-and-launch disclosure and an outcome-only receipt. `subagent_await` likewise leaves partial hierarchy rendering to the widget, then persists an outcome-first final summary without repeating the call title or target count. Expanded final awaits render reports first and the static settled hierarchy afterward. If the widget cannot be installed, partial start and await cards retain their prior live hierarchy fallback. Persisted details use strict version 2 and one Effect Schema model. Start requires request-ordered entries and stores no run cards; await requires cards plus its wait condition. Makers and decoders strip private or unknown fields, reject malformed known children without partial salvage, deep-freeze their output, and cap canonical serialized details at 48,000 characters. Older history falls back to its bounded terminal-sanitized text instead of reconstructing version-1 cards. Other current results use persisted semantic route/run/action cards with IDs, safety intent, timing/activity, humanized usage, mixed-target recovery, shared accent disclosure affordances with `ctrl+o` hints for hidden tasks, reports, failures, and fallback lines, and explicit omission evidence. Every selected model route uses compact `model:effort ⚡` notation when its candidate uses OpenAI priority service. Hierarchy run rows keep one stable width-bounded line at every terminal width. The tree identity and animated or settled state glyph come first, the operational ID stays muted, and route metadata plus optional writer, usage, tool, and timing details follow as room permits; redundant state words are omitted.

All three local adapters are self-contained. They own process and private-harness cleanup inside the current parent Pi session.

For Claude and Codex, supervisor MCP report delivery—not raw final CLI text—owns completion. Local candidates always close on report. Each writer process scope closes before its pool membership detaches, and the final confirmed member releases the shared lease. Supervisor progress, warning, exact correlated question/reply, and report identities/sequences are forwarded unchanged into the backend event queue; warning events update projection/history only, questions steer immediately, and reports or failures use the coalesced outcome notifier. Claude stream input is confirmed only by exact native replay (the CLI may apply guidance at its next safe turn boundary). Steering's ten-second caller wait can return uncertainty while Claude continues: the backend retains the UUID under a separate absolute five-minute watchdog, never resends, and rejects additional input or queue-cancelling interruption until resolved. Stop remains available. Status distinguishes pending/confirmed delivery from completed reports whose guidance stayed unconfirmed; unresolved terminal guidance blocks route retry. Native write uncertainty and initialization/start timeouts still fail closed. Claude interruption includes `cancel_queued:true`. Codex interruption waits for both the correlated JSON-RPC success and matching `turn/completed(status=interrupted)` in either order and emits no later settlement event. Normal Claude and Codex completion both use exact-epoch causal `SupervisorChannel` acceptance evidence recorded before the MCP call is acknowledged, so an accepted report wins even while its queue event is behind progress and a missing/wrong-epoch report fails instead of hanging; Claude's epoch-zero native initialization result remains non-assignment evidence. Native Claude/Codex do not advertise resume, rename, peer notice, or fork.

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

An explicit `profile` always wins; an omitted profile uses `generalist`. The main agent chooses profiles by the required deliverable, and each profile uses its configured model route. Configuration and tool inputs accept only the seven profile IDs listed above.

## Configuration version 6

Global configuration is `<agent-dir>/pi-subagents.json`. Trusted projects may override it at `<cwd>/<CONFIG_DIR_NAME>/pi-subagents.json` (normally `.pi/pi-subagents.json`). Both scopes use the same document shape; untrusted project configuration is not read.

```json
{
  "version": 6,
  "defaultProfileSet": "review",
  "profileSets": {
    "review": {
      "profiles": {
        "reviewer": [
          {
            "host": "local",
            "runtime": "claude",
            "model": "opus",
            "effort": "high",
            "context": "fresh",
            "writeIntent": "read-only",
            "closeOnReport": true
          },
          {
            "host": "local",
            "runtime": "pi",
            "model": "openai-codex/gpt-5.6-sol",
            "effort": "high",
            "context": "fresh",
            "writeIntent": "read-only",
            "openaiFastMode": true,
            "closeOnReport": true
          }
        ],
        "scout": "disabled"
      }
    },
    "writers": {
      "profiles": {
        "worker": {
          "host": "local",
          "runtime": "pi",
          "model": "parent",
          "effort": "default",
          "context": "fresh",
          "writeIntent": "writer"
        }
      }
    }
  },
  "nesting": {
    "maxDirectChildren": 12,
    "maxDepth": 3
  }
}
```

Each document may contain at most 32 scope-local sets. Names are 1–64 characters, start and end with a letter or number, and may otherwise contain letters, numbers, spaces, `.`, `_`, or `-`. A set always contains `profiles`, which may be empty. Global and project sets with the same name are independent.

`defaultProfileSet` is optional. A project without one inherits the selected global set; a global document without one inherits built-ins. Sets may be partial: each missing project route inherits the selected global route, and each missing global route inherits its built-in. An invalid declared default fails all routes in that scope closed but does not prevent the saved-set library from opening for repair. Current Session starts from one complete resolved baseline above these persistent layers.

A route is exactly `"disabled"`, one candidate, or a non-empty ordered candidate array (maximum 32). Candidate fields are:

- required `host`: `local` only;
- `runtime`: `pi`, `claude`, or `codex`;
- `model`: a bounded native runtime selector; Pi uses `parent` or canonical `provider/model`, including registry-owned `@` context variants;
- `effort`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `default` means the profile's soft default, while `generalist` inherits the current parent effort and falls back to `high`;
- `context`: `fresh` or `fork`;
- `writeIntent`: `read-only` or `writer`;
- optional `openaiFastMode`, defaulting to false; when true, eligible Pi or Codex candidates request OpenAI's `priority` service tier;
- optional `closeOnReport`, omitted or `true` only.

Cross-field rules remain strict: `fork` and `parent` require local Pi; `closeOnReport: false` is unsupported; and `openaiFastMode: true` requires an eligible Pi/OpenAI or Codex priority route. Unknown root keys fail document activation. Invalid present routes fail only that route closed. Diagnostics redact profile-set names.

Versions 4 and 5 remain read-compatible. Their root `profiles` field and candidate `fastMode` field migrate on the next successful store write to `profileSets.default.profiles`, `defaultProfileSet: "default"`, and `openaiFastMode`. Migration refuses malformed legacy containers, invalid sibling routes, and unknown legacy fields rather than discarding them. Version 6 accepts only `openaiFastMode` and writes no legacy `fastMode` key. Present invalid nesting values fail strict decoding and are never clamped. Nesting precedence is Session over trusted Project over Global over Built-in. `/subagents settings` edits Session, Global, or trusted Project policy. Lowering a limit does not stop current runs; later batches use the newly captured revision.

Version 6 also accepts the optional root boolean `ultracode`, defaulting to `false`. A trusted Project value overrides Global, and an absent Project value inherits it. Saved values apply to new sessions or after `/reload`; a Session value set with `/ultracode on|off` or `/subagents settings` applies at once. A non-boolean value (including the string `"true"`) stops activation for that document; correct the JSON before reloading. See [Scripted workflows](#scripted-workflows).

The legacy version-6 `automaticProfileRouting` and `scriptedWorkflows` keys are accepted but ignored; existing files are not automatically rewritten.

### Current Session and saved sets

`/subagents profiles` always opens Current Session, the only active working set. It begins as a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Per-profile edits apply immediately to later launches and `subagent_models`; active runs keep their admitted routes. The header shows what Current Session is based on and how many profiles have changed.

`p Profile sets` opens a separate Project and Global library. Enter opens explicit actions for a saved set: Use in Current Session, Edit saved set, Make default for new sessions, clear the current default, Copy, Rename, and Delete. Clearing a Project default makes new sessions use Global; clearing a Global default uses built-ins when no Project default applies. Using a valid set previews all seven routes and replaces Current Session in one revision-checked transition. Saved-set edits and default changes never alter Current Session. Invalid sets remain visible but cannot be applied or made default, including partial Project sets that inherit an invalid Global route. Route-invalid sets can be repaired in the editor; structurally invalid sets must be deleted and recreated, and malformed unnamed defaults have a clear action. `s Save Current Session` writes one full seven-profile snapshot to a prompted Project or Global destination without making it default. It refuses fail-closed inherited routes and holds the session revision lock through persistence, so the saved set matches the reviewed Current Session.

Current Session writes no project, global, or Pi session-history data. It survives `/tree` and `/reload` through the bounded handoff, and clears on `/new`, `/resume`, `/fork`, quit, or process restart.

### Repairing retired remote or stay-open configurations

Existing documents are never rewritten automatically, and no credentials or standalone `pi-herdr-btw` settings are changed. Any route containing `host: "herdr"` fails closed in its entirety, even when its other candidates are local. A candidate with `closeOnReport: false` likewise invalidates the route. This applies to legacy v4/v5 documents as well as v6 and inherited Global routes in partial Project sets.

Open `/subagents profiles` and explicitly replace invalid routes with reviewed local Pi, Claude, or Codex candidates, supplying `host: "local"` and omitting `closeOnReport` or setting it to `true`. Review model, effort, context, and write intent; native selectors need not transfer across runtimes. Repair the source Global set or explicitly override its inherited route in Project. Invalid sets cannot be used, made default, or saved as a valid Current Session snapshot. Route-invalid sets remain editable; structurally invalid sets must be deleted and recreated, and invalid defaults must be replaced or cleared before deleting their sets. Reload or explicitly apply a valid saved set after persistent repair. There is no automatic local fallback, retention substitute, or credential migration.

If `/reload` encounters an in-memory Current Session handoff containing retired candidates, subagents remain inactive rather than inheriting a different local route. Start a fresh Pi session after repairing persistent settings; repeated reloads or tree navigation do not bypass this protection.

## Starting and waiting

For substantial work, first check whether the task contains at least two independent workstreams. Launch one to three bounded read-only assignments early in one batch, then continue the main agent's independent work. Good delegation candidates include unfamiliar or multi-package codebase reconnaissance, external research that can run beside local inspection, implementation planning, and independent review. Skip delegation for trivial or tightly serial tasks.

Prefer `scout`, `researcher`, `planner`, `reviewer`, and `oracle` for parallel read-only work. Use `worker` only for explicit implementation handoffs. The main agent may keep editing while isolated worktree writers run. In `shared-checkout` mode it coordinates and reviews without editing while a writer pool is active; a claimless worker is exclusive and concurrent workers need pairwise-disjoint exact `writes` paths.

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

For scoped parallel implementation, with one cooperative checkout by default or separate worktrees when `worktree` is selected:

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

In shared-checkout mode these paths prevent overlapping admission. In either mode they guide scope, but do not restrict what native tools or Bash can physically mutate.

Use `subagent_models` to inspect complete configured candidates and static eligibility; executable/auth/harness readiness is checked at launch. It does not claim unsupported backends are available. Successful reports and terminal failures that are not claimed by an await are delivered automatically; ordinary warnings stay in status/history and are included with the eventual outcome rather than starting their own turns. When a failed notification says candidates remain, call `subagent_lifecycle({ action: "retry", runIds: [...] })` before launching a generalist replacement. Retry preserves the original task/profile and advances the frozen route without re-attempting the failed candidate; repeat only on a failed successor, and use generalist only after `retry_route_exhausted`. Use `subagent_await` only at a dependency or synthesis barrier, and use it rather than polling status; “finished” means the selected run has completed, failed, or stopped. A parent question returns early so the parent can call `subagent_reply` and await again. `subagent_send` guides active runs; `resume` is for paused or closed completed sessions where advertised.

Cancelling `subagent_await` cancels only that wait. Its saved result retains requested IDs, latest observed states, and pending parent actions; children continue. Root-local waits join claim cleanup before returning, so their IDs can be awaited again when needed. Proxy waits without progress explicitly report unobserved states and unconfirmed root claim cleanup; immediate replacement awaits may conflict until cleanup finishes. Cancellation is never a reason to restart completed work.

Local Pi completes only after `agent_settled` confirms a successful nonempty final response. Final provider errors, unrequested aborts, truncated/tool-use-only endings, and missing reports fail explicitly after automatic retries finish. Failure does not undo writes. Inspect existing work before an authorized explicit retry; uncertain execution or unconfirmed cleanup still blocks continuation. Report availability distinguishes missing text from text claimed elsewhere or already delivered; older history without this metadata remains unknown.

## Scripted workflows

`subagent_workflow` runs a dynamic workflow: a JavaScript script that starts agents with `agent()`, combines them with `parallel()` and `pipeline()`, and returns one value. It runs in the background in Pi's QuickJS sandbox, and its result or error arrives as one notification that starts the main agent's next turn, so the main agent ends its turn after starting it instead of polling status; repeated status calls while nothing changed get a one-line answer. Workflow agents are ordinary root subagents, writers included, and Activity shows each workflow with its phases and agents. A failed or stopped run can be started again with `resumeFromRunId`, which reuses the results of identical `agent()` calls. See [dynamic workflows](docs/workflows.md#dynamic-workflows) for the script API, saved workflows, writers, notifications, and resume.

Before writing a non-trivial script, the main agent reads the bundled [workflow authoring guide](skills/workflow-authoring/SKILL.md): when a workflow is worth it, how many agents a request calls for, pipelines and barriers, review and verification patterns such as adversarial voting and loop-until-dry, and claims-first large implementations. The tool description stays an API reference with a one-line sizing rule and points at the guide; see [authoring guidance](docs/workflows.md#authoring-guidance).

Native codemode can also run root-session read-only workflows in the main agent's own turn, using structured start, await, status, and lifecycle-stop results. The main agent chooses profiles and workflow branches; an omitted `profile` uses `generalist`. Script-origin descendants and retry successors remain read-only; separately authorized root writer launches are unaffected. Parent attention hands control back to the main agent; writers, retries, replies, claims, and workspace review stay explicit. See [foreground codemode scripting](docs/workflows.md#foreground-codemode-scripting). Reload Pi after updating the package.

Workflows are opt-in, as in Claude Code. The `ultracode` setting, off by default, is the standing opt-in: while it is on, `subagent_workflow` is in the main agent's tools, the footer shows `ultracode`, and the system prompt asks the main agent to run substantive tasks as workflows. `/ultracode on` and `/ultracode off` set it for the session; `/subagents settings` saves it in Global or trusted Project scope for new sessions. `/ultracode [+500k] <task>` opts in for one request, with an optional output-token budget: the tool stays available through the request, its workflow runs, and the turn that handles their notifications, then leaves the loadout again. Bare `/ultracode` shows the setting, any open window, and the saved workflows. Ultracode gates only `subagent_workflow`: codemode scripts can always call the four root tools, which are ordinary subagent calls within `maxDirectChildren`. Local Pi child proxy tools are always model-only. See [opting in](docs/workflows.md#opting-in).

## Reviewing and integrating worktree proposals

`writerWorkspaceMode` is a session-wide setting, persisted globally or in trusted project configuration through `/subagents settings`. It defaults to `shared-checkout`; `worktree` opts into isolated editing and parent-reviewed integration. Changing it is refused while writer ownership or unresolved workspace artifacts remain. Only the root may launch worktree writers in this release; nested writer launches fail explicitly. Read-only nesting and shared-checkout nesting remain supported. Nested read-only runs inherit their authenticated parent's effective cwd, including an isolated worktree, rather than the root checkout. Start and status receipts identify the writer mode, workspace ID, and actual cwd.

A completed writer report does not approve its changes. Its direct parent follows this workflow automatically, without asking for routine user approval:

1. Call `subagent_workspace` with `{"action":"review","workspaceId":"..."}` after process cleanup. Keep the returned `revisionId` and inspect every diff page, passing the same ID and each `nextOffset` back to `review`. Pages contain up to 16,000 characters and are not summaries.
2. Call `prepare` with the workspace ID and exact reviewed revision ID. This creates a separate cwd combining the proposal with current parent edits.
3. Run relevant tests in that combined cwd. Do not edit the prepared tree. Worker-only tests do not replace this combined test pass.
4. After review and passing tests, call `integrate` with the exact `workspaceId`, `revisionId`, and `preparationId`. It applies the proposal as uncommitted edits, preserving the parent index and local work. It does not merge a branch, stage, or commit.

Conflicts or stale parent/preparation state fail closed. Prepare again and rerun combined tests after parent drift. For rejected changes, `revise` takes a workspace ID and concrete feedback in `message` and starts a successor writer; await that run and review again. Once the successor is admitted, the prior revision and preparation are stale, `list` shows the workspace as active, and the next review reopens it and freezes a new revision. A revise whose successor isn't admitted, for example at direct-child capacity, leaves the reviewed revision, tested preparation and earlier revision request as they were. Until the successor is admitted or refused, the workspace refuses review, prepare, integrate, discard and another revise, even if the revise call itself was abandoned. A workspace this session integrated, discarded or left mid-integration can't be resumed or revised (`workspace_finished`), though a kept worker tree can still be discarded. `discard` explicitly removes an unwanted proposal after cleanup. `list` pages workspace metadata with optional `offset`. Workspace operations authorize only the authenticated direct parent, not every ancestor; a child cannot approve itself or supply an owner identity.

A committed integration removes the proposal's test trees and its worker tree, unless a live run, such as a reader the writer started, still works inside them. If the worker holds files the integrated revision left out, such as a writer's `.env`, vendored files or unsupported file types, the worker tree is kept and `integrate` warns, naming the files and the tree: copy what you need, then `discard` the workspace to delete it. This applies even at paths the source checkout itself excludes; only gitignored files don't count. `integrate` also warns when the trees couldn't be removed (discard retries the removal) and when the source writer lease couldn't be released: the integration still stands, but this session then refuses writer starts and further integrations until Pi restarts.

Each worktree writer launch holds one of the root's direct-child slots while it creates its workspace, and other starts and resumes count that slot; a workflow agent's launch holds none, since workflow agents have their run's own concurrency. A launch that only other launches' slots would block waits for one of them to finish rather than creating a workspace that admission would refuse. A worktree writer start that is never admitted frees its slot, then discards the workspace it created.

Private worktrees use a standalone bare repository seeded from the eligible current checkout, not the source object database or its history. Source and private-worktree snapshot exclusions cover ignored/generated/dependency state and known credential filenames and formats only; safe untracked source files may be included. This is a bounded source snapshot, not a complete clone or a secret-detection guarantee. Dependencies and excluded local configuration may need separate test setup. Existing tracked internal file aliases such as `CLAUDE.md -> AGENTS.md` are preserved; symlink changes and links outside the eligible snapshot are refused. Worktrees do not sandbox native tool access. See [snapshot and recovery limits](docs/local-backends.md#isolated-workspace-lifecycle) before manual recovery.

## Commands and tools

- `/subagents` opens the shared Activity manager focused on Subagents, preserving the authorized parent-before-child hierarchy and selected bounded details. `j/k` or arrows navigate, Enter inspects, `h/l` change pane or expand/collapse hierarchy, and `q` closes. Capability-checked actions include `m` guidance/reply/next assignment, `i` interrupt, `u` resume with optional guidance, `e` rename, and `x` stop the subtree; destructive actions require confirmation. `t` shows technical details. Inputs recheck the same session, assignment, question, and current action policy after typing; pending/unresolved native guidance never counts as delivered and blocks another guidance/interrupt. Missing shared UI retains the standalone fleet; an admitted, rejected, cancelled, or replaced shared opening never falls back to a second overlay. Nested Pi retains its authenticated-subtree fleet.
- `/subagents settings` edits nesting limits, persisted writer workspace mode, and the `ultracode` switch: bare in a terminal it opens a settings list, and `help`, `status`, and `[session|global|project] <id> <value>` work anywhere. Typing `/subagents ` autocompletes `profiles` and `settings`.
- `/ultracode` reports whether ultracode is on, any open one-off window, and the saved workflows; `/ultracode on|off` sets it for the session, and `/ultracode [+500k] <task>` runs one request as a workflow. Typing `/ultracode ` autocompletes `on` and `off`.
- `/subagents profiles` opens Current Session at the first profile; `/subagents profiles worker` opens worker directly. Use `j/k` for rows, `h/l` for panes, and Tab to switch Current Session/Saved profiles. `m`/`e`/`r` open Model/Reasoning/Run with. Each candidate's Manage menu (`a`) contains Duplicate, valid moves, and Delete. Add fallback (`+`) and Undo changes appear once under the selected profile; the left pane's Save action or `s` saves all Current Session profiles as a set. In the saved library, Enter edits and `u` previews a whole-session replacement. Saved-set edits never apply implicitly. See [Settings workspace](docs/settings-workspace.md) for navigation, auto-save, and scope semantics.
- Agent tools: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, `subagent_rename`, parent-only `subagent_claims`, direct-parent `subagent_workspace`, and root-only `subagent_workflow` (always registered, active only while workflows are opted in). `subagent_list` renders its bounded cards as a parent-before-child hierarchy. During a root TUI await, the persistent widget marks completion-controlling targets with `◎`; descendant state changes refresh that hierarchy but never change the requested wait condition or claim descendant reports. The claims tool lists, grants, and revokes exact cooperative ownership while a worker waits on a parent claim question with no other active tool, and resumes writer admission after the parent reviews a detected violation. Lifecycle action `retry` continues failed runs through their remaining frozen profile route with exact predecessor/successor lineage; it is not same-candidate rerun or automatic failover. Start calls keep names/profiles compact and reveal bounded tasks only when expanded; final start cards are immutable launch receipts, not live run cards. Other collapsed cards prioritize the requested action, outcome, route/safety identity, and next step. Partial start and await cards omit duplicate hierarchy when the widget is available, while non-TUI, nested, and widget-failure paths keep the bounded card renderer. Narrow layouts preserve the tree and state glyph first, then truncate lower-priority details. Expanded list and status cards add full IDs, wrapped provenance/capabilities, and profile-candidate reasons. Expanded await cards render preserved reports/errors before the static settled hierarchy, showing only exceptional fallback, warning, writer, or failure diagnostics; finished assignments never retain stale progress lines. `subagent_models` renders effective route source and static eligibility separately from launch-time checks.

Every local Pi launch snapshots the **root** Pi's current active tool names. `writeIntent` does not filter that snapshot: Pi read-only is a prompt and writer-lease coordination contract, not capability confinement or a filesystem sandbox. Only competing coordinator/orchestrator implementations are denied; package-owned `subagent_*` names resolve to authenticated proxies. Active names are activation requests, not code transfer, so the child must discover an implementation. The snapshot is fixed for that launch; nested starts snapshot root state again, and child-local tool toggles do not define a grandchild's inventory.

In a trusted child, an active and discoverable native codemode is therefore available for either write intent. Native nested calls pass through Pi tool hooks and emit tool-execution events, including file-claim observation; approvals and registered overrides are not bypassed. Coordinator proxy tools are always model-only. Read-only agents must still avoid mutation, but neither that prompt nor declared claims confines native tool authority. Native Claude and Codex tool/sandbox policies are unchanged and do not inherit this Pi snapshot. Every local Claude launch requires the current strict subprocess sandbox (`enabled`, `failIfUnavailable`, no unsandboxed fallback), an empty network allowlist with strict denial, and explicit filesystem write policy. Both read-only and writer routes expose Bash only through sandbox auto-allow; read-only explicitly denies Bash writes to the assigned cwd, while a writer allows that cwd, omits Write/NotebookEdit, and grants Edit only through a canonical-cwd-scoped current permission pattern. Bare Bash/Edit/Write never appear in `allowedTools` or `permissions.allow`. Unsupported Bash-sandbox platforms fail with `claude_shell_confinement_unsupported`, unsupported writer paths fail with `claude_writer_confinement_unsupported`, and unavailable sandbox dependencies fail selected startup rather than running unsandboxed.

Claude's OS sandbox directly confines Bash and is the stronger boundary. Edit is a separate Claude file-tool permission policy, not a sandboxed subprocess; this adapter depends on the current CLI's scoped-path and symlink enforcement and does not claim a general OS boundary for file tools. Explicit WebFetch/WebSearch and model traffic are also outside the Bash network sandbox, so this is not a confidentiality/offline guarantee. Claude `--safe-mode` is not used because it removes the required stdio MCP path; empty setting sources, strict MCP, fixed tools, and validated native MCP inventory retain that helper while admin-managed policy can still apply. Codex uses its native read-only/workspace-write sandbox, while the adapter-owned supervisor MCP helper intentionally runs outside it. Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.

## Runtime-native agents

Every Claude and Codex run may use native agents within that runtime's own limits. Native agents inherit the parent run's read-only or writer sandbox and lease. They are internal runtime activity, never Pi run nodes, and never consume Pi direct-child or depth capacity. Parent rows and details show bounded active, total, and latest native activity where the protocol exposes it. Pi provides no native-agent controls.

Claude allows `Agent`, `Task`, `TaskOutput`, `TaskStop`, and `SendMessage`, requests forwarded subagent text, and retains its MCP report and interrupt correlation. Codex enables `multi_agent` and `[agents]`, decodes bounded `collabAgentToolCall` and `subAgentActivity` items, and treats unknown native shapes as protocol failures.

### Diagnosing Claude steering

When native acknowledgement is still pending after the ten-second caller wait, `subagent_send` lists the worker under `Guidance awaiting confirmation`. The backend is still tracking delivery, so the call is not a tool error and does not claim delivery. Do not resend, retry, interrupt, or replace the worker merely for that reason; continue or await it, and stop remains available. Status reports the later `steeringDelivery` fact. Unconfirmed and failed targets remain errors.

For an opt-in live timing probe, set `PI_SUBAGENTS_REAL_CLAUDE_MODEL` and `PI_SUBAGENTS_REAL_CLAUDE_STEERING_SCENARIO` (`tool`, `generation`, or `native-agent`), then run `pnpm --filter pi-subagents smoke:local-claude-steering`. This can incur provider usage and never runs in the normal suite. See [timing evidence and probe limits](docs/local-backends.md#live-steering-timing-probe). Failure diagnostics retain bounded metadata and the actual termination cause, not raw prompts or native identifiers.

## Native preflight safety

Preflight validates bounded native model-selector syntax and a deliberately static current effort vocabulary. Claude Code's zero-inference initialize response is used to resolve aliases at selected startup, but account entitlement can still fail after selection; that failure does not fall through. Codex 0.145's generated `ReasoningEffort` schema remains an open string, so the adapter documents and permits only `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; delegation-enabling/unknown values remain excluded. Codex disables provider fallback and verifies the exact model returned by `thread/start` before issuing a turn.

Harness preparation is failure-atomic after its unique private directory is created: write/sync/chmod/auth/config failures remove partial state. Unconfirmable removal returns `harness_cleanup_unconfirmed` and leaves the already-private state fail-closed for inspection rather than claiming deletion.

## Cross-process writer safety

Writer cwd is resolved with `realpath` for launch and diagnostics, then identified by the directory's stable local filesystem device plus inode/file ID. The bounded SHA-256 identity digest keys both the in-memory guard and a pi-cosmic-core `CrossProcessLock` slot under the private `<agent-dir>/subagents/writer-leases-v3/` root; a directory rename therefore cannot evade ownership. Project files receive no lock, receipt, or report artifact. Local Windows writer starts fail with typed `unsupported_safe_writer_ownership` before canonicalization, lease acquisition, or spawn because safe descendant ownership requires a Job Object implementation. Local read-only starts remain available.

A newly acquired pool lease is `reserved` (core quiescent). The first pool member durably marks it `spawn-started` (core native-pending) before any member driver call. Later members share that mark while the pool remains held. A new pool created for a later respawn performs a fresh acquire and mark. Mark failure means no waiting member invokes its driver, and the pool stays quarantined until restart. Release settles a marked lease durably before relinquishing it; any failed mark, settle, or release keeps the slot held. Conflict messages do not name the other session's run, session, or process.

The core lock retires only a positively dead quiescent owner. A detached local child can outlive its parent, so a dead `spawn-started` owner, corrupt evidence, or an unsafe lock root is never reclaimed or repaired. First independently verify that every external backend descendant is dead, then recover the private lock state manually. The protocol assumes same-host Pi parents share one agent directory on a local filesystem with stable device/inode identity; distinct agent homes, distributed hosts, and filesystems without those semantics are outside the coordination domain.

**Upgrading from protocol v2.** Restart every running Pi session after upgrading. Older sessions cannot see v3 locks, so exclusion works only one way while old and new versions run side by side. A leftover `<agent-dir>/subagents/writer-leases-v2/<digest>.lease` slot for the same directory denies writer startup with a message naming its path. Remove it manually only after every older Pi session has exited.

Every member's backend/process cleanup must confirm before it detaches. The final member alone authorizes lease release. If any backend cleanup or lease release cannot be confirmed, the entire cwd pool remains quarantined. Graceful session shutdown closes each backend before the final release. An uncatchable parent termination after `spawn-started` leaves a deliberate manual-recovery lock, even if the surviving backend later exits.
