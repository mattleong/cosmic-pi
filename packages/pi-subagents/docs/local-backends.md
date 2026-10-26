# Local backend, writer pools, and workspaces

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and [Completion and delivery](completion-delivery.md) for assignment and report ownership.

The local Pi adapter translates the child's native behavior into normalized handles, controls, and events. Run orchestration never constructs or decodes native wire frames, and backend continuation state is an opaque token that only its adapter interprets.

## Shared process transport

- The driver allocates a bounded, backpressured event ingress in its scope. A raw frame's transport ownership and byte budget stay attached until orchestration consumes its last normalized event; closing the scope releases every still-owned frame.
- Activity events only refresh a throttled liveness timestamp, so while one activity event for an assignment is pending, later ones release their raw frame without enqueueing. Streaming deltas never fill the queue or delay other events.
- The JSONL transport bounds unacknowledged bytes at 8 MiB and events at 65,536; either overflow forces termination. Stdout is never paused, because a consumer holding queued events may be waiting on a later RPC response from the same stream.
- Spawn through finalizer registration is masked, so closing the caller's scope always releases a process that exists. Cleanup confirms process-group absence before releasing ownership. Forced termination sends SIGTERM and allows two seconds before SIGKILL.
- For writers, the transport snapshots process groups that the child's members started outside its own group before any signal, because those are reparented once the child dies. Release stays `cleanup_unconfirmed` while a recorded group survives, and incomplete discovery refuses later explicit recovery. A writer that exits on its own, such as after a crash, was never snapshotted, so its release stays unconfirmed (`descendant-snapshot`) until manual recovery.
- When a child's output ends, pending initialization, requests, and input fail with the exit status followed by bounded, sanitized stderr, so a rejected flag reaches the failed launch. Scope teardown keeps immediate generic closure and never waits for an exit receipt.
- Pi children exit within about a second of stdin closing, which happens when the root process dies, so no parent-death watchdog runs. Pi's crash paths exit without closing scopes, so a [host-exit guard](../../pi-cosmic-core/src/platform/process-group-exit-guard.ts) also sends SIGKILL to each child's process group if the root process exits while it is held. The transport holds it from spawn until its scope closes, or until the child exits and its group is already gone. It doesn't reach groups the child's members started outside its own, such as Pi's bash commands, or survive a SIGKILL of the root process.

Child stdout lines are limited to 4 MiB. The shared parser never buffers an oversized line: it keeps a 2 KiB prefix and 256-byte suffix, discards the rest through the newline, and keeps parsing.

Pi repeats whole messages and tool results (including images up to 4.5 MiB) in aggregate events. The backend skips oversized `agent_end`, `turn_end`, `entry_appended`, and tool-result `message_start`/`message_end` events; settlement comes from `agent_settled`. A skipped `turn_end` or `entry_appended` still refreshes usage. An oversized `tool_execution_end` closes its tool from the leading `toolCallId`/`toolName` and trailing `isError`. Any other oversized event fails the run as a protocol error.

## Local Pi ownership and safety

### Launch and transport

- Children launch Pi's bundled `dist/bundle/cli.js` in RPC mode over stdin/stdout with bounded, schema-decoded frames.
- The initial `get_state` handshake has a 30-second deadline; ordinary RPC commands and IPC acknowledgements have 10 seconds. Startup expiry never replays the request or sends the task, and the failed launch joins owned cleanup before returning.
- Natural transport closure waits for the exit receipt before rejecting pending RPCs, preserving bounded stderr and exit code or signal.
- A separate bounded Node IPC channel to the root carries parent contact, peer notices, ancestor outcomes, and authenticated coordinator proxy calls. `boundary/local-pi-ipc.ts` is the only owner of raw `child.send`/`process.send`, its listeners, and schema decoding in both directions.
- Each assignment-start control carries a monotonic epoch, and the adapter tags assignment-scoped events with it. Definite start failure restores the prior epoch; outcome-uncertain failure keeps the attempted one.
- Fresh children use a dedicated session directory; forks receive a private copy of the stable parent branch.
- A child whose `get_state` reports a different model than its route (ignoring `@` context variants) fails with `pi_model_mismatch`. After startup, status follows the `provider/model` each assistant `message_end` reports; relaunch and resume still use the route's model.
- Children load extensions from Pi settings and installed packages only, never the root's temporary `-e` extensions. A model registered only by a `-e` provider fails with `pi_model_not_found` and a `pi install` remedy in its detail.
- Pi children run on `process.execPath`. When that binary is gone (for example after `brew upgrade`), every launch preflight fails with `node_executable_missing` and a restart-Pi message.

### Environment and credentials

- Pi children inherit the parent environment except Node loader settings, Pi session identity, and Git's repository-local variables (`git rev-parse --local-env-vars` and `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`), so a parent started from a Git hook cannot redirect a child's Git.
- Runtime API keys cross through an ephemeral environment bootstrap, never argv. `boundary/host-child-pi.ts` consumes and scrubs them once during child extension registration.
- The OpenAI priority-tier hook reads `pi-subagents-fast-mode` on each provider request (Pi applies CLI flags after loading extensions). Only boolean `true` enables it, and each request still checks the active provider, model, and payload.

### Forks

Route planning skips a forked candidate with `fork_context_too_large` when the parent's context exceeds 80% of that model's window. A fork copies the stable parent branch. Labels become inert `pi-subagents-fork-anchor` custom entries, every entry keeps its ID, parent link, and timestamp, and resuming the child's own session does not sanitize its transcript. The launch allowlist and competing-orchestrator denylist stay authoritative over executable tools.

A fork never inherits the parent's prompt state: parent `role: "system"` messages and Better OpenAI encrypted checkpoints become inert anchors, inherited compactions lose only `systemMessage`, and Pi reconstructs the plaintext branch behind them. Assistant thinking is copied; Pi sends it only to the model that produced it.

### Guidance, interruption, and turn input

Guidance is an RPC `prompt` with `streamingBehavior: "steer"`, because a bare `steer` to a settled child is queued with no run to consume it. Input hooks may transform or handle guidance, so the adapter reads the returned `disposition`:

- `queued` and `started` deliver it; `started` discards the settlement the child reported before it.
- `handled` fails with `guidance_not_delivered`, or `prompt_not_delivered` for assignment-start and resume prompts, restoring prior assignment evidence.
- An unreadable response keeps the attempted epoch as outcome-uncertain. Nothing replays the task automatically.

Natural settlement first waits for admitted guidance, parent replies, and descendant notifications to drain, then drops a settlement that guidance made stale. It commits the report in the same lock hold that finds no input still admitted, and waits again otherwise.

Pi's `abort` leaves the steering and follow-up queues in place, so resumable interruption:

1. closes run-level turn-input admission and waits for admitted guidance, replies, and notifications to drain;
2. takes the session-local turn-control semaphore that replies and notifications share;
3. sends and confirms an IPC barrier, proving the child processed every earlier input;
4. issues correlated `clear_queue`, discards the returned text, and sends `abort`.

Parent replies are acknowledged after the waiting tool resumes, or rejected if the question is gone. Notifications are acknowledged after the child synchronously admits `pi.sendMessage`. The child (`boundary/host-child-settle.ts`) takes a notification only while the run the parent's prompt opened (`before_agent_start` with `messageType: "user"`) is working and hasn't reached its own `agent_before_settle`, or a continuation's `turn_start` has reopened it. It sends with `triggerTurn: false`, so Pi appends it at turn end or abort, `clear_queue` never removes it, and the settle check continues the run so the child reacts. At any other time, idle, settling, or in a run another extension started, it refuses, and the notification falls through to the next ancestor or the root. A nested parent that has already written its final report therefore never folds a late descendant report into it; the root gets that report directly. An acknowledgement-uncertain notification is retried while that ancestor stays eligible, and falls through once it isn't. A report the child took counts as delivered only once its assignment completes; failure, pause, or stop hands it on ([delivery](completion-delivery.md#delivery)).

After `pauseRequested`, new guidance, replies, and ancestor notifications are rejected and paused ancestors are skipped. Barrier, clear, or transport failure suppresses later interruption commands and releases the pause claim. `clear_queue_outcome_uncertain` is distinct from post-abort `interrupt_outcome_uncertain`; only the latter keeps a pending pause that late settlement may confirm.

### Tool snapshot and read-only semantics

- At every launch the root snapshots its current active tool names and project-trust decision. Competing coordinator and orchestrator tools and pi-intercom's cross-session `session_*` tools are always denied, and a [custom agent](routing.md#declaration)'s `tools.allow` and `tools.deny` filter the snapshot further, always keeping the child's own `agent_*` tools, `agent_contact_parent` included. The root never passes its own `agent_*` tools down; the child registers authenticated proxies for them.
- A read-only child never gets Pi's file-mutation tools `edit` and `write`. Its snapshot drops them even when a custom agent's `tools.allow` names them, and the start entry then warns. Every spawn, nested and resumed ones included, also passes them to `--exclude-tools`, so Pi never registers them for that child, whatever an extension or codemode asks. Writers keep them.
- The public extension returns before importing the root application when `PI_SUBAGENT_CHILD === "1"`; a packaged private extension registers authenticated proxies of the root's `agent_*` tools and its own `agent_contact_parent`. Nested children have no `/subagents` command; the root's Activity view shows every descendant.
- An active name is not an implementation transfer: the child can use it only when its trust mode discovers the provider. A nested start returns to the root for a fresh snapshot, so child-local toggles do not control grandchildren. The snapshot's count, names, and size are validated before ownership.
- Proxy requests cannot carry ancestry. The root binds them to the channel's run and authorizes `agent_await` and `agent_lifecycle` targets against that subtree, while `agent_list`, `agent_read`, and `agent_send` targets may be any agent in the tree; `agent_worktree` mutations use the stricter direct-parent check.
- Read-only withholds Pi's `edit` and `write` tools and adds a no-mutation prompt and writer-lease policy. It is cooperative, not an OS sandbox or confidentiality boundary, and no subagent runs sandboxed. `bash` and the other inherited tools, native codemode included, stay available to either intent and can still change files, so the prompt tells readers to use them only to inspect and validate. Codemode's nested tool events surface as activity.

### Child bridge

`boundary/host-child.ts` owns one session-runtime slot for the started child session. A scoped Layer attaches the IPC listener and detaches it on replacement or shutdown. Only the current session identity and slot token may register or execute proxy tools and `agent_contact_parent`; a partial registration removes those names and closes the runtime.

Each question and proxy call owns one exact Deferred entry through `acquireUseRelease`. Release deletes only the same waiter, listener release and shutdown reject all remaining correlations, and a disconnect from a detached listener cannot reject the replacement session's waits.

## Local Pi usage

- `get_session_stats` snapshots are cumulative. The initial snapshot excludes copied parent history, and a process-lifetime high-water mark emits deltas across paused and resumed assignments, never rebasing on lower or malformed totals.
- A valid baseline is required before the first prompt, so unavailable startup stats fail initialization. Later accounting failures are best effort and never fail a run.
- Stats requests use a scoped, coalesced lane that refreshes after `turn_end`, `compaction_end`, and `entry_appended`, and before settlement.
- Usage is charged only to the exact owning handle, rechecked under the mutation lock, and never changes activity, report text, or terminal evidence.

## Structured child questionnaires

- Only explicit blocking `ask_user` requests from local Pi children are relayed, through the versioned `pi-ask-user/protocol` root capability. `pi-ask-user` remains the sole registrar and must be discoverable in the child; a missing relay or capability fails closed.
- Asynchronous questionnaires, `agent_contact_parent` questions, and raw `extension_ui_request` forwarding are not supported.
- The root derives owner run, assignment epoch, and request ID from coordinator state. A separate strict 128 KiB decoder keeps questionnaires out of tool input.
- `run/questionnaire-lifetime.ts` keeps at most 256 request-ID tombstones per assignment, so replayed answered or cancelled identities cannot reopen a dialog.
- Pause, stop, settlement, and assignment replacement revoke queued, visible, or hidden waits; process cleanup joins their finalizers outside the service lock, and shutdown revokes before leaf-first release. A stalled owned cleanup keeps stop and shutdown waiting.
- Deliberate cancellation remains a cancelled outcome, not an invitation to retry through another UI.

## Writer pools and cross-process safety

The root `SubagentService` owns one writer pool per directory. Nested Pi writer requests enter the same admission path, so pools and leases are tree-wide. Pools are keyed by a SHA-256 digest of the directory's device and inode, so relative and symlink aliases collide and renaming does not change ownership. Read-only runs never join a pool.

The first member acquires and durably marks the cross-process lease before any member spawns; concurrent members wait for that preparation. The lease is held until the last member confirms backend cleanup. A run whose startup falls back keeps its membership while its failed candidate's processes close, so the lease passes to the next candidate without a gap ([startup fallback](routing.md#startup-fallback)).

### Shared-checkout writers

- Any number of in-process shared-checkout writers may join one pool. Admission has no file claims: writers coordinate by task scope, and the parent assigns disjoint scopes.
- Admission still refuses a writer while the pool is releasing, failed, or quarantined, or while a member in the same cwd is still confirming cleanup. A worktree writer's pool is its private worker directory.
- Another Pi process holding the cwd's lease refuses the whole pool. Applying a worktree proposal into a checkout where a shared-checkout writer is active or launching, or rolling one back, fails with `workspace_target_busy`.
- Shared-checkout writers are not isolated. Their tools can modify the whole cwd, and nothing observes or stops a write outside the assigned task. Writer guidance and the peer notice tell each writer which peers share the cwd and their tasks, to agree on overlapping work with the running peer through `agent_send`, to tell peers about changes they depend on, and to ask the parent when they can't agree.

### Leases

Writer leases use pi-cosmic-core's `CrossProcessLock` under `<agent-dir>/subagents/writer-leases-v3`, namespaced by the identity digest; neither slot name nor evidence exposes the path.

- `acquire` makes one non-waiting, uninterruptible `tryAcquire` whose fsyncs run off the event loop; marks, settles, and releases commit synchronously. A live owner is a `live` conflict; a dead native-pending owner, corrupt evidence, or an unsafe root mode is `recovery-required`. Conflict messages never name the other session's run, session, or process.
- `markSpawnStarted` commits before any driver call, so parent death afterward requires manual recovery: detached process groups may survive. Recover only after verifying the backend and descendants are dead (`owner.json` names the owner's process), then remove the named lock directory.
- Every mark, settle, or release sets the lease phase to `uncertain` until its commit returns, so any failure keeps the slot held and quarantines the pool until restart.
- A pool created for a later respawn performs a fresh acquire and mark.
- Coordination assumes same-host Pi processes share one agent directory on a local filesystem with stable device/inode identity.

### Cleanup ordering and quarantine

- Stop and shutdown wait for every admitted spawn attempt to settle, close the backend scope once, and only then detach pool membership.
- Non-final members detach only after confirmed cleanup; only the final member authorizes lease release. A failed cleanup keeps the member attached, and an unconfirmed release keeps the whole pool quarantined with its process capacity and writer ownership.
- Cleanup quarantine is tracked per member; recovering one member never frees another, and healthy peers keep the lease.
- `cleanup` is absent until cleanup starts, then `pending`, `confirmed`, or `quarantined`, with a bounded redacted phase, reason, and `stop` or `manual` recovery policy.
- Stop verification is session-owned and single-flight. Only failures attested by the exact process transport are eligible; mixed finalizer failures, incomplete descendant evidence, and uncertain lease commits stay manual. Recovery never closes a closed scope, signals retained PIDs, rediscovers reparented descendants, or retries an uncertain lease commit. Confirmation requires the exact child's exit and absence of every recorded process group.

## Isolated workspace lifecycle

The parent's review and apply procedure is in the [reference](reference.md#reviewing-and-applying-worktree-proposals); this section owns the contract.

### Mode and admission

- A writer's mode is chosen at admission ([Public launch contract](routing.md#public-launch-contract)) and recorded; revision successors keep it. Changing the session default affects only later launches, and settings show how many workspaces in this checkout remain unresolved.
- A `worktree` writer launches in a detached, locked linked worktree of the user's repository at `<agent-dir>/subagent-worktrees/<id>/worker`. Its cwd lease protects that directory, not the parent checkout.
- Only the root starts worktree writers. A nested caller's writers share its checkout or worker tree whatever the session default, and one whose custom agent sets `isolation: "worktree"` fails with `workspace_nested_writer_unsupported`.
- Read-only runs never acquire workspaces, and nested readers inherit their parent's effective cwd, including a worktree.
- A worktree launch checks its parent and its tree and direct-child capacity first, then holds one parent direct-child slot until admission or failure. Held slots count toward direct-child and tree limits. If running runs alone fill a limit, the launch fails at once; if only creating launches fill it, it waits interruptibly, holding nothing.
- The binding is recorded as soon as the engine acquires the workspace. A start that is never admitted frees its slot and discards the workspace; if that discard fails, the binding remains for the parent to discard. Admitted starts that fail keep their workspace as an ordinary proposal.

### Worktrees and captures

The engine (`workspace/service.ts` over `boundary/git-*.ts`) makes every tree a workspace needs a linked worktree of the source repository, and keeps its commits there under `refs/pi/workspaces/<id>/` (baseline, revision, prepared, whose parent commit is the parent capture it was built on, and rebase-worker). Git lists the trees in `git worktree list`, locked with the reason `pi-subagents workspace <id>`.

- **Captures** never touch a real index. A copy of the tree's index (keeping skip-worktree and assume-unchanged bits, and its timestamp, so racily clean files are rehashed) takes `git add --update` and the untracked files Git's ignore rules leave eligible, then `git write-tree`. Commits are unsigned, with a placeholder identity, parented on the tree's HEAD or the previous baseline.
- **Baseline:** tracked files with their staged and unstaged content, and untracked files Git doesn't ignore, except credential-shaped names (`.env*`, `.npmrc`, `secrets*`, `credentials*`, `*.pem`, SSH keys) and untracked nested repositories. The worker is checked out from it, so its index holds the baseline.
- **Worker and prepared trees** leave out untracked credential files a writer created (`.env*`, `.npmrc`, `*.pem`, `*.key`, SSH keys, `credentials.json`, `secrets.txt`) but keep credential-named source such as `src/auth/credentials.ts`. The revision records them as `uncapturedPaths`; review lists them, prepare and apply warn (`credential-files-left-out`), and none of them blocks. Ignored files never enter a revision. A writer's own `git add` counts as tracked, except for [included files](#included-files), which no capture ever takes.
- **Git configuration** is the user's, system and global included, so filters such as Git LFS, line-ending rules, and ignore files behave as in a normal checkout. Every call forces `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.splitIndex=false` (so temporary indexes never write a shared index into the user's Git directory), `commit.gpgSign=false`, `submodule.recurse=false`, and `gc.auto=0`, sets `GIT_OPTIONAL_LOCKS=0`, and drops repository-local variables such as `GIT_DIR` and `GIT_INDEX_FILE`. Patches use plumbing with explicit prefixes, without external diff or textconv.
- **Refused states:** bare repositories, repositories without a commit, sessions inside Git metadata, sparse checkouts, and unmerged indexes; at freeze, any change to a submodule entry, because a checkout leaves a submodule's own repository alone. Each refusal names the path, rule, and remedy. Main and linked worktrees, submodule checkouts, and SHA-1 or SHA-256 repositories work as sources.
- **Limits:** 48 MiB per revision patch.
- Review pages are text: bytes that aren't UTF-8 show as replacement characters there, while preparation applies the stored patch's exact bytes.

The worktrees share the user's object database, refs, and configuration, so `git log --all` shows workspace commits and a mirror push would publish `refs/pi/*`. Native Pi tools keep local-user authority, so isolation is not a confidentiality boundary or sandbox. Ignored dependencies are absent unless a `WorktreeCreate` hook installs them, and ignored local files such as `.env` unless `.worktreeinclude` names them.

### Writer guidance

A worktree writer's Git commands reach the user's repository, and only guidance keeps them apart. The writer's system prompt says its workspace is a worktree on a detached HEAD shared with the parent's repository, and tells it to:

- stay on that detached HEAD, without creating or switching branches;
- leave its changes unstaged and uncommitted, as a proposal for the parent;
- not use `git stash`, whose stack every worktree of the repository shares;
- not change Git configuration, which the user's checkout reads too;
- not run `git worktree` commands, which could unlock, move, or remove the workspace's own trees.

Captures read the worker's index and files rather than its HEAD, so changes a writer commits anyway still appear in its proposal.

### Worktree hooks

Root `hooks` in global and trusted-project documents declares commands for two events, mirroring Claude Code's `WorktreeCreate` and `WorktreeRemove`. Unlike Claude Code's, they never replace the engine's own worktree creation or removal: `WorktreeCreate` runs after the engine creates a tree, and `WorktreeRemove` before it removes one. Untrusted project hooks are ignored. Changes apply after `/reload`.

```json
{
  "version": 6,
  "hooks": {
    "WorktreeCreate": [{ "command": ["pnpm", "install", "--offline", "--frozen-lockfile"] }],
    "WorktreeRemove": [{ "command": ["./scripts/stop-dev-db"], "timeout": 30 }]
  }
}
```

- Each event takes up to 16 hooks, each `{ "command": [argv...], "timeout"?: 1-3600 }` seconds (600 by default for `WorktreeCreate`, 60 for `WorktreeRemove`). A fractional timeout is floored and one outside its bounds clamped. A hook with a malformed command or timeout or an unknown key is invalid, as is an event list that isn't an array of at most 16. An invalid `WorktreeRemove` hook is dropped and the others still run. Because setup is sequential, any invalid `WorktreeCreate` declaration in either scope, or a `hooks` value that isn't an object, fails closed: activation succeeds, but every tree's setup fails with `workspace_hook_failed` naming the diagnostic, before any hook runs, and doctor reports it. Unknown events are ignored. Each case leaves a configuration diagnostic. Global hooks run first, then the project's, one at a time.
- A hook runs without a shell at the tree's root, with the user's environment minus Git's repository-local variables, in its own process group with bounded output. Its stdin is one JSON object: `event`, `workspaceId`, `worktreePath` (the tree's root), `sourceCwd`, `kind` (`worker` or `prepare`), and `runId` when the writer run is known.
- **WorktreeCreate** runs in each new worker tree before the writer starts, in each tree `prepare` builds for testing, and in a tree rebuilt by `revise` with `rebase`, never on a plain revise or in the tree a one-call `apply` prepares. Hooks stop at the first failure. Afterwards the tree must match its baseline apart from ignored and credential files. Changed files, a non-zero exit, or a timeout fail with `workspace_hook_failed`: a new workspace is discarded before its writer starts, and a preparation is withdrawn, as is one whose hooks were interrupted. A writer never launches into a tree whose setup hooks didn't finish.
- **WorktreeRemove** runs, best effort, in a worker or prepared tree immediately before the engine removes it: integration cleanup, discard, automatic discard, orphan discard and sweep, and collection of retained trees. Trees that create or prepare roll back themselves never run it. A non-zero exit, a timeout, or unconfirmed process cleanup is a logged warning, and the tree is removed anyway. It runs while the engine holds the checkout's lock, so keep it short.
- A hook that times out, or whose operation is interrupted, has its process group stopped with SIGTERM, then SIGKILL. Like Git commands, a hook's group is killed if the root process exits while it runs. A group that can't be confirmed stopped, even after a hook that exited 0, is a logged warning naming the workspace; it changes no outcome and quarantines nothing.
- WorktreeCreate hooks hold neither the operation lock nor the checkout's lock while they run. The coordinator keeps their workspace creating, revising, or busy meanwhile, so other operations on it refuse, and unrelated workspaces proceed.

For pnpm, `["pnpm", "install", "--offline", "--frozen-lockfile"]` installs from the local store, and workspace links resolve to the isolated tree's own packages.

### Included files

A `.worktreeinclude` file at the top level of the source checkout names untracked local files isolated trees need, such as `.env`, one gitignore-syntax pattern per line; blank lines and `#` comments are skipped. It is read at each workspace's creation, regardless of project trust, because it only copies the user's own files and runs nothing. Without the file nothing is included. A file that isn't regular, exceeds 64 KiB, or holds more than 64 patterns, a pattern over 1,024 characters, or a control character refuses creation. `/subagents doctor` lists the patterns.

- **Matching:** at creation, Git matches the patterns against the source tree's untracked files from its top (`git ls-files --others --ignored --exclude=<pattern>...`). Only files the baseline doesn't carry, ignored or credential-named ones, qualify; tracked files and untracked files the baseline already holds are unaffected. Symlinks, nested repositories, and other non-regular files are skipped.
- **Limits:** at most 256 files and 64 MiB per tree. More fails creation before the worker is checked out, naming the counts; install dependencies with a `WorktreeCreate` hook instead.
- **Copies:** each match is copied with its permission bits into the worker tree, and the record lists them as `includedPaths`. Every prepared tree receives the parent's current copies of those paths, skipping any that are gone, no longer regular files, or tracked in that tree. A rebase leaves the worker's copies as they are, even staged ones, which it unstages.
- **Never captured:** every capture of a worker or prepared tree drops the included paths from its scratch index before Git hashes anything, so they never enter Git objects, revisions, review, or integration, even after the writer edits them, un-ignores them, or stages them. They are not reported as left-out credential files.

### Review, apply, and revise

A final report changes no parent files. Only the authenticated direct parent integrates, and only through `agent_worktree apply`; a root that [adopted](#orphans-takeover-and-collection) an orphaned proposal is that proposal's parent for apply, discard, and revise. Both paths write uncommitted edits without changing the parent index, branch, or commits. Every operation on a finished writer's workspace first waits, interruptibly, for that writer's process cleanup to settle (up to 30 seconds); a running writer or quarantined cleanup refuses with `workspace_process_unsettled`.

- **Quick path:** `apply` with only `workspaceId` freezes the current revision (an optional `revisionId` must match, else `workspace_revision_stale`), prepares it against current parent work without running `WorktreeCreate` hooks, and integrates that pair; removing its trees afterwards runs `WorktreeRemove` hooks. Its result reports that nothing was tested (`untested`), so the parent runs relevant tests in its checkout.
- **Careful path:** `review` freezes the proposal and pages its immutable text, 16,000 characters at a time: a summary (diffstat, changed files, left-out credential files) then the patch, never splitting a character. Paging needs only `offset`; it reads the current revision. `prepare` takes the reviewed `revisionId`, refusing with `workspace_revision_stale` once a resume or revision has replaced it, so the tree the parent tests holds the revision it reviewed; nothing checks how many pages were read. It builds the combined cwd and runs the `WorktreeCreate` hooks there; the parent tests there; then `apply` integrates that preparation without preparing again, reporting `parent-tested`. `apply` uses the parent's preparation whenever it is the current one (and matches an optional `revisionId`).
- **Preparation** captures the parent's current files, applies the revision's patch to that capture as Git objects (so filters and line endings never disturb it), and checks the result out as a locked worktree.
- **Conflicts:** a patch that doesn't apply to current parent files fails `prepare` with `workspace_conflict`, naming the files, before any tree is made. Integration refuses parent edits to proposal files (`workspace_parent_changed`), a changed branch or staged entries, a changed worker or test tree, and uncertain cleanup; parent edits to other files are kept and named in a warning.
- **Hidden local edits:** prepare and integration refuse with `workspace_local_override`, naming the files, while the parent index marks a file the proposal changes skip-worktree or assume-unchanged (`git ls-files -v` tags `S` or lowercase). Git reads the indexed blob for such a file, so captures can't see its local edit and integration would overwrite it. Clear the bit with `git update-index --no-skip-worktree` or `--no-assume-unchanged`, or revise the workspace so it leaves the file alone.
- **Revise** starts a backend-neutral successor assignment whose admission makes the old review and preparation stale. With `rebase`, the engine first commits a capture of the worker, captures the source like a new launch, then moves the worker in place (keeping its directory identity) to the new baseline with a two-tree `read-tree`, which touches only tracked files, and reapplies the changes with `git apply --3way` against the old baseline as the real merge base. Conflicted files keep markers and are listed in the successor's task. A merge that can't run, or would overwrite an untracked or ignored worker file, refuses with `workspace_rebase_refused`, moves the worker's files back, and restores its index. A later failure restores the worker from its capture once the record names the previous baseline again (a rebuilt record whose save failed after landing is first replaced by the previous one); if the previous record can't be put back, the rebuilt worker is kept with its record, and either failure names `refs/pi/workspaces/<id>/rebase-worker`, which holds the captured files.
- **Discard** deletes an unwanted proposal.
- A frozen revision's patch lives in `revision.diff` beside the record.
- Persisted details keep IDs, counts, paging metadata, and the testing status, never whole patches.

### Binding states and resume

Each binding has exactly one state:

- `creating` (acquisition until admission or refusal) and `revising` (a revise call holds it for its successor) refuse other operations with `workspace_process_unsettled`.
- `busy` marks a root operation's hold; others fail with `workspace_operation_in_progress`.
- `idle` carries the current revision's knowledge: unreviewed, reopened (stale after resume or revision admission), frozen once reviewed, or prepared once ready, recording whether `prepare` built it for testing (after its `WorktreeCreate` hooks succeeded) or a one-call apply did.
- `stopped-integration` follows an integration that stopped partway; only discard, which rolls it back, may follow.
- `finished` records integrated, discarded, or discarded automatically.

Resume and revise never change the workspace before the writer is admitted.

- Resume validates everything, the binding included, in one locked claim. It refuses a busy binding, a binding a revision successor uses (`workspace_owner_unavailable`), a finished or mid-integration workspace (`workspace_finished`), and any worktree resume while integration is quarantined. A live process resumes in place; otherwise the reviewed revision becomes stale.
- Revise checks the binding, quarantine, and capacity under the run lock, then holds the binding. The successor's launch takes over that hold first, so an abandoned call doesn't release it. Admission commits the revision; refusal leaves the review, preparation, and earlier request unchanged.
- While a revision is stale, reviewing, preparing, or applying the old revision fails with `workspace_revision_stale`, and the next review freezes a new revision. Otherwise a review without `revisionId` returns the current frozen revision from offset 0.

### Concurrency

- Review and prepare queue on the coordinator's workspace operation lock, mark the binding busy, and call the engine outside the run lock.
- Integration, discard, and automatic discard queue on the same lock and keep the binding busy. They check occupancy under the run lock, then run the engine outside it in the session scope, and commit the outcome under it again, so other runs, messages, and tools proceed meanwhile.
- Until that engine work ends, it excludes the workspace's trees and, for integration or rollback, the target checkout from new runs: read-only and shared-checkout launches there wait, and resuming a run there refuses with `workspace_operation_in_progress`. Cancelling the caller interrupts the work and waits for it to end, as shutdown does; integration and rollback run to their end once they hold the target's leases.
- Worktree launches and revise rebases need no exclusion: every engine operation of a session queues on the engine's in-process operation gate before taking the checkout's store lock, so one behind this session's integration or discard waits for it rather than timing out on that lock.
- Apply keeps the binding busy throughout and takes the operation lock for each phase; `prepare` releases it while the prepared tree's `WorktreeCreate` hooks run.
- Integration and the rollback of a stopped one refuse with `workspace_target_busy` only while a shared-checkout writer is active, cleaning up, or launching in an overlapping cwd, or another session's writer holds the source root's or session directory's lease. Worktree launches don't block them, because the engine orders their snapshots.
- Discard refuses while any run holds a directory within the artifact or is launching into one.
- Every mutating engine operation holds a `CrossProcessLock` keyed by the real root of the record's source checkout, under `<agent-dir>/subagent-worktrees/locks`. Only other sessions contend for it. Waits poll interruptibly for up to two minutes, then fail naming the owner process, and say when that process is this one; a dead owner's lock is reclaimed. Listing takes no lock.
- Git is resolved once per process (`/usr/bin/git`, else the first absolute `git` on `PATH`) and must be 2.31 or later.

### Integration and rollback

Integration holds the writer-pool leases on the source root and session directory, rechecks the worker, the tested tree, the parent's HEAD and staged entries, hidden local edits, and parent drift in the proposal's files, then writes only the paths where the preparation's parent capture and tested tree differ.

- A parent file at such a path that captures leave out, such as an ignored one, would be replaced untested, so it refuses with `workspace_parent_changed`. So does replacing a directory with a file. Every existing directory leading to a written path must be a real directory, never a symlink or file.
- The record is saved `integrating` before the first write. `git read-tree` loads the tested tree into a scratch index in the workspace's directory, and `git checkout-index -f -z --stdin` writes the added and changed paths into the parent checkout, applying filters, line endings, executable bits, and symlinks as a checkout would. Changed `.gitattributes` files are written first, in their own run, because `checkout-index` reads attributes from the checkout's files, so the other paths follow the proposal's rules. Deleted paths are then removed, with directories that left empty, never the source root or the session directory and its ancestors. Written files take Git's checkout permissions. The parent's index, branch, and commits are never touched.
- Integration is not an atomic multi-file transaction. A failure or crash after the first write leaves the record `integrating` and the binding `stopped-integration`, and releases the leases; other workspaces proceed.

`discard` rolls it back, holding the same writer-pool leases as integration, so no shared-checkout writer edits a touched file between the comparison and the checkout. For each changed path, Git compares the file with its parent and tested entries as `git status` would, through a scratch index of those entries. A path that holds either side, or nothing, is put back: checked out from the parent capture, or removed where the parent had nothing. If any path holds something else, rollback changes nothing and refuses with `workspace_rollback_refused`, naming the files; put each back to either side (`git show refs/pi/workspaces/<id>/prepared^:<path>` for the parent's, `…/prepared:<path>` for the proposal's) and discard again. The comparison reads attributes from the checkout as it stands, so after an integration that changed a `.gitattributes` file, a touched file whose filters or line endings that file governs may be judged to hold neither side, and rollback refuses it. Once the owning session has ended, another session's root may roll it back the same way ([Orphans, takeover, and collection](#orphans-takeover-and-collection)).

`workspace_integration_quarantined` refuses integration only while the session is quarantined, after a failed lease release or an unreadable integration outcome. Writer admission and integration then stay quarantined until Pi restarts.

After a committed integration the engine removes the proposal's `prepare-*` trees and worker tree, keeping trees a live run still uses, and deletes its refs. Each tree goes with `git worktree unlock` and `git worktree remove --force`, which also removes Git's entry when the tree's directory is already gone; the engine never runs `git worktree prune`, which would also drop the user's own entries whose directories are missing. Trees kept this way go at a later startup's collection ([Orphans, takeover, and collection](#orphans-takeover-and-collection)). A failed removal is a warning.

### Automatic cleanup

After a `completed` worktree writer's cleanup is confirmed, a session-owned fiber compares its worker tree with the baseline.

- With no changed files and no left-out credential files, it discards the workspace and records `workspaceOutcome: auto-discarded`. Resuming that writer fails with `workspace_finished`.
- Otherwise it records a `proposal` with changed and left-out (`uncapturedFileCount`) counts and a bounded diffstat: line totals and the first 20 files (paths clipped to 256 characters; condensed cards keep only totals).
- Failed and stopped writers, and workspaces that are busy, resumed, revised, reviewed, prepared, in use, or fail inspection, are kept.
- This never delays report delivery or `agent_await`. Resume or revision admission clears a recorded outcome.

### Orphans, takeover, and collection

Each record names the owner lease its creating engine holds until its runtime closes; a free lease proves that session ended. Its other unfinished workspaces are then orphans, which another session's root may take over, discard, or, after a month, sweep.

- **Listing.** The root's `list` probes each other session's owner lease and marks an orphan `adoptable` (active, frozen, or prepared) or `discard-only` (mid-integration). The mark is advisory; every operation rechecks under the checkout's lock.
- **Takeover.** When the root calls `review`, `prepare`, `apply`, or `revise` on a workspace no live binding owns, the coordinator first adopts it: it takes the original writer lease and requires the worker path to still resolve to its saved filesystem identity, then the engine, under the checkout's store lock, refuses mid-integration records and a held owner lease, rechecks the worker identity, and rewrites the record's owner and owner lease to this session. The coordinator then holds a run-less, unreviewed binding owned by the root, and the operation runs as on its own workspace.
- **Revising an adopted workspace.** Its first `revise` resolves the recorded launch (profile or custom agent, and name, saved at creation) like a start item with this session's configuration, and launches a new run with `message` as its task and the worker tree as its cwd; it has none of the original writer's conversation. A recorded custom agent runs with its current route and instructions. A recorded profile or agent that no longer starts writers, or an agent that is no longer configured or fails closed, refuses with `workspace_launch_unavailable`. Later revisions extend that successor's request as usual.
- **Discard.** The root may discard any orphan. Discard takes the original writer lease with the same identity check, rechecked immediately before each removal. A mid-integration orphan is rolled back first, as the owning session's discard would. Preparation trees are removed before the worker, and discard is recorded only after editable trees, their worktree entries, and the workspace's refs are gone.
- **Sweep.** Once per root session start, in the background, orphans of the session's checkout (the records its `list` shows) unchanged for 30 days (`lastChangedAt`) are discarded, skipping any a takeover would refuse. Each is frozen first unless its revision still matches the worker, so `revision.diff` holds its changes; then its trees and refs are removed and the record is saved `discarded` with `disposition: "orphan-swept"`. One user notification lists each swept workspace's ID, changed-file count, and patch path; it never enters model context. Collection then keeps the record and patch for 7 more days.
- Records without writer-identity evidence (an unfinished create) and unreadable records are never adopted, discarded, or swept this way.
- **Collection.** At startup each runtime collects discarded and integrated records a week after their last change, under their checkout's lock, unless an editable tree remains. First, under the same lock, it removes the trees and refs integration kept for a live run, once the record's owner lease is free, so no run can still use them. It also discards a record its create left `creating` once that session's owner lease is free, removing the worktree and refs a crash left in the user's repository. Unreadable records block collection.
- Listing separates valid records from fixed-size unavailable-artifact diagnostics; one unreadable record never hides healthy neighbors. Root listings keep unknown artifacts without inferred metadata; nested listings show only exact-owner records. Visibility grants no mutation authority.

For manual recovery, confirm every writer process and descendant is dead, preserve the proposal and its refs, and compare the changed paths with `refs/pi/workspaces/<id>/prepared` and its parent commit. Remove a worktree with `git worktree unlock` and `git worktree remove`, never by deleting its directory alone, and never remove a tree or lease solely because the parent PID exited.

## Private state housekeeping

Local Pi run directories (`<agent-dir>/subagents/<session>/<run>-<runtime suffix>`) each carry an `owner.json` naming the root Pi process and its start identity.

- Normal cleanup removes them. Each root session start sweeps the rest in the background: an entry goes once its owner is provably dead. An entry whose owner record is missing or unreadable goes once it is unchanged for seven days; one whose recorded owner can't be proven dead, such as an identity in another format, is kept.
- Removal renames to a `.swept-` tombstone first, so a concurrent Pi never reads a half-deleted directory. Failures are skipped.
- The runtime suffix keeps a resumed session's run directories apart from an earlier process's, since random run IDs aren't guaranteed unique.
- The sweep never touches reports, writer leases, workspaces, or unrecognized directories, and nested children never sweep.

## Completion ownership

- Only `agent_settled` decides a Pi child's outcome, using the latest assistant attempt's bounded text and stop reason. A successful `stop` with nonempty text completes. Provider errors, unrequested aborts, output limits, tool-use-only endings, and empty reports fail with up to 2,000 characters of the failing attempt's own text. Before that, the child bridge gives a textless final message one hidden reminder to write its report; earlier messages are never promoted to the report.
- Failures can leave completed writes behind; the parent continues by resuming the run or starting a new one.
