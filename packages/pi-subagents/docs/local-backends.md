# Local backends, writer pools, workspaces, and the supervisor channel

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and [Completion and delivery](completion-delivery.md) for assignment and report ownership.

All three local adapters translate native behavior into normalized handles, controls, and events. Run orchestration never constructs or decodes native wire frames, and backend continuation state is an opaque token that only its adapter interprets.

## Shared process transport

- Each driver allocates a bounded, backpressured event ingress in its scope. A raw frame's transport ownership and byte budget stay attached until orchestration consumes its last normalized event; closing the scope releases every still-owned frame.
- Activity events only refresh a throttled liveness timestamp, so while one activity event for an assignment is pending, later ones release their raw frame without enqueueing. Streaming deltas never fill the queue or delay other events.
- The JSONL transport bounds unacknowledged bytes at 8 MiB and events at 65,536; either overflow forces termination. Stdout is never paused, because a consumer holding queued events may be waiting on a later RPC response from the same stream.
- Spawn through finalizer registration is masked, so closing the caller's scope always releases a process that exists. Cleanup confirms process-group absence before releasing ownership. Forced termination sends SIGTERM and allows two seconds before SIGKILL.
- For writers, the transport snapshots process groups that the child's members started outside its own group before any signal, because those are reparented once the child dies. Release stays `cleanup_unconfirmed` while a recorded group survives, and incomplete discovery refuses later explicit recovery.
- When a CLI's output ends, pending initialization, requests, and input fail with the exit status followed by bounded, sanitized stderr, so a rejected flag reaches the failed launch. Scope teardown keeps immediate generic closure and never waits for an exit receipt.
- Pi, Claude, and Codex children exit within about a second of stdin closing, which happens when the root process dies, so no parent-death watchdog runs.

Child stdout lines are limited to 4 MiB. The shared parser never buffers an oversized line: it keeps a 2 KiB prefix and 256-byte suffix, discards the rest through the newline, and keeps parsing.

- **Pi** repeats whole messages and tool results (including images up to 4.5 MiB) in aggregate events. The backend skips oversized `agent_end`, `turn_end`, `entry_appended`, and tool-result `message_start`/`message_end` events; settlement comes from `agent_settled`. A skipped `turn_end` or `entry_appended` still refreshes usage. An oversized `tool_execution_end` closes its tool from the leading `toolCallId`/`toolName` and trailing `isError`. Any other oversized event fails the run as a protocol error.
- **Claude** closes an oversized `user` line whose first part is a `tool_result` as a success for that `tool_use_id`, and counts an oversized `stream_event` as activity. Other oversized Claude lines are protocol errors.
- **Codex** treats every oversized line as a protocol error.

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
- Pi children and the Claude/Codex supervisor helper run on `process.execPath`. When that binary is gone (for example after `brew upgrade`), every launch preflight fails with `node_executable_missing` and a restart-Pi message.

### Environment and credentials

- Pi children inherit the parent environment except Node loader settings, Pi session identity, and Git's repository-local variables (`git rev-parse --local-env-vars` and `GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`), so a parent started from a Git hook cannot redirect a child's Git.
- Claude and Codex children receive only an allowlist: identity, locale, paths, certificate settings including `NODE_EXTRA_CA_CERTS`, and proxy variables.
- Runtime API keys cross through an ephemeral environment bootstrap, never argv. `boundary/host-child-pi.ts` consumes and scrubs them once during child extension registration.
- The OpenAI priority-tier hook reads `pi-subagents-fast-mode` on each provider request (Pi applies CLI flags after loading extensions). Only boolean `true` enables it, and each request still checks the active provider, model, and payload.

### Forks

Route planning skips a forked candidate with `fork_context_too_large` when the parent's context exceeds 80% of that model's window. A fork copies the stable parent branch. Labels become inert `pi-subagents-fork-anchor` custom entries, every entry keeps its ID, parent link, and timestamp, and resuming the child's own session does not sanitize its transcript. The launch allowlist and competing-orchestrator denylist stay authoritative over executable tools.

A fork **shares the parent's prompt cache** (`sharesParentPromptCache`) when its model is the parent's current model and the transport can carry the child's prompt and tool changes after the inherited history without changing the request prefix: Anthropic Messages with mid-conversation system messages and tool changes, or OpenAI Responses/Azure with mid-conversation system messages and added tools or tool search.

- The root passes the parent session ID as `PI_SUBAGENT_PROMPT_CACHE_KEY`, and the copy keeps the parent's system messages, compaction `systemMessage` fields, and assistant thinking verbatim.
- Authority still comes from the child: its first prompt patch replaces or removes every differing inherited section, and Pi executes only the child's registered tools.
- Anthropic requests withdraw the parent's other tools in place. OpenAI Responses requests keep the parent's tool declarations, drop the child's removals and redefinitions, add its new tools, and carry the parent's `prompt_cache_key`. A request that no longer starts with the inherited prompt, such as after the child compacts, is sent unchanged.
- Branches whose system messages carry prompt text, or that hold an encrypted checkpoint, are isolated instead. Codex is excluded because Pi derives its `session-id` header from the child's own session.

Every other fork is **isolated**: parent `role: "system"` messages and Better OpenAI encrypted checkpoints become inert anchors, inherited compactions lose only `systemMessage`, Pi reconstructs the plaintext branch behind them, and assistant thinking is excluded for cross-model portability.

### Guidance, interruption, and turn input

Guidance is an RPC `prompt` with `streamingBehavior: "steer"`, because a bare `steer` to a settled child is queued with no run to consume it. Input hooks may transform or handle guidance, so the adapter reads the returned `disposition`:

- `queued` and `started` deliver it; `started` discards the settlement the child reported before it.
- `handled` fails with `guidance_not_delivered`, or `prompt_not_delivered` for assignment-start and resume prompts, restoring prior assignment evidence.
- An unreadable response keeps the attempted epoch as outcome-uncertain. Nothing replays the task automatically.

Natural settlement first waits for admitted guidance, parent replies, and descendant notifications to drain, then drops a settlement that guidance made stale.

Pi's `abort` leaves the steering and follow-up queues in place, so resumable interruption:

1. closes run-level turn-input admission and waits for admitted guidance, replies, and notifications to drain;
2. takes the session-local turn-control semaphore that replies and notifications share;
3. sends and confirms an IPC barrier, proving the child processed every earlier input;
4. issues correlated `clear_queue`, discards the returned text, and sends `abort`.

Parent replies are acknowledged after the waiting tool resumes, or rejected if the question is gone. Notifications are acknowledged after the child synchronously admits `pi.sendMessage`. The child (`boundary/host-child-settle.ts`) starts a turn for a notification only while idle; while working it sends with `triggerTurn: false`, so Pi appends it at turn end or abort, and `clear_queue` never removes an acknowledged notification. An acknowledgement-uncertain notification stays owned by that ancestor rather than falling through.

After `pauseRequested`, new guidance, replies, and ancestor notifications are rejected and paused ancestors are skipped. Barrier, clear, or transport failure suppresses later interruption commands and releases the pause claim. `clear_queue_outcome_uncertain` is distinct from post-abort `interrupt_outcome_uncertain`; only the latter keeps a pending pause that late settlement may confirm.

### Tool snapshot and read-only semantics

- At every launch the root snapshots its current active tool names and project-trust decision. `writeIntent` does not filter them; only competing coordinator and orchestrator tools are denied.
- The public extension returns before importing the root application when `PI_SUBAGENT_CHILD === "1"`; a packaged private extension registers authenticated `subagent_*` proxies. Nested children have no `/subagents` command; the root fleet shows every descendant.
- An active name is not an implementation transfer: the child can use it only when its trust mode discovers the provider. A nested start returns to the root for a fresh snapshot, so child-local toggles do not control grandchildren. The snapshot's count, names, and size are validated before ownership.
- Proxy requests cannot carry ancestry. The root binds them to the channel's run and authorizes targets against that subtree; workspace mutations use the stricter direct-parent check, apart from the ancestor discard in [Nested worktree writers](#nested-worktree-writers).
- Pi read-only is a no-mutation prompt and writer-lease policy, not a sandbox or confidentiality boundary. It receives the same tool snapshot as a writer, so native codemode is available to either intent; codemode's nested tool events participate in claim observation.
- Native Claude and Codex launches keep their fixed tools and sandboxes and do not consume the snapshot.

### Child bridge

`boundary/host-child.ts` owns one session-runtime slot for the started child session. A scoped Layer attaches the IPC listener and detaches it on replacement or shutdown. Only the current session identity and slot token may register or execute proxy tools and `contact_parent`; a partial registration removes those names and closes the runtime.

Each question and proxy call owns one exact Deferred entry through `acquireUseRelease`. Release deletes only the same waiter, listener release and shutdown reject all remaining correlations, and a disconnect from a detached listener cannot reject the replacement session's waits.

## Local Pi usage

- `get_session_stats` snapshots are cumulative. The initial snapshot excludes copied parent history, and a process-lifetime high-water mark emits deltas across paused and resumed assignments, never rebasing on lower or malformed totals.
- A valid baseline is required before the first prompt, so unavailable startup stats fail initialization. Later accounting failures are best effort and never fail a run.
- Stats requests use a scoped, coalesced lane that refreshes after `turn_end`, `compaction_end`, and `entry_appended`, and before settlement.
- Usage is charged only to the exact owning handle, rechecked under the mutation lock, and never changes activity, report text, or terminal evidence.

## Structured child questionnaires

- Only explicit blocking `ask_user` requests from local Pi children are relayed, through the versioned `pi-ask-user/protocol` root capability. `pi-ask-user` remains the sole registrar and must be discoverable in the child; a missing relay or capability fails closed.
- Native Claude/Codex, asynchronous questionnaires, `contact_parent` questions, and raw `extension_ui_request` forwarding are not supported.
- The root derives owner run, assignment epoch, and request ID from coordinator state. A separate strict 128 KiB decoder keeps questionnaires out of tool input.
- `run/questionnaire-lifetime.ts` keeps at most 256 request-ID tombstones per assignment, so replayed answered or cancelled identities cannot reopen a dialog.
- Pause, stop, settlement, and assignment replacement revoke queued, visible, or hidden waits; process cleanup joins their finalizers outside the service lock, and shutdown revokes before leaf-first release. A stalled owned cleanup keeps stop and shutdown waiting.
- Deliberate cancellation remains a cancelled outcome, not an invitation to retry through another UI.

## Writer pools, cooperative claims, and cross-process safety

The root `SubagentService` owns one writer pool per directory. Nested Pi writer requests enter the same admission path, so leases and disjoint claims are tree-wide. Pools are keyed by a SHA-256 digest of the directory's device and inode, so relative and symlink aliases collide and renaming does not change ownership. Read-only runs never join a pool.

The first member acquires and durably marks the cross-process lease before any member spawns; concurrent members wait for that preparation. The lease is held until the last member confirms backend cleanup.

### Claims

- A writer without `writes` owns the whole cwd exclusively. A writer with `writes` owns exact normalized paths, and admission rejects case-insensitive overlap with active members and reservations.
- Claims are fixed at launch; nothing grants or revokes them while the writer runs. To change files, relaunch with corrected claims.
- Absolute paths and the `<outside workspace>` and `<temporary directory>` audit markers can't be claimed.

Each observed native write path is resolved lexically against the cwd and classified:

- **Workspace:** under the cwd or its macOS `/private` alias, compared case-insensitively and checked against claims in workspace-relative form (`./src/a.ts` matches `src/a.ts`).
- **Temporary:** strictly under `os.tmpdir()`, `/tmp`, or `/var/tmp` (and their `/private` spellings), unless that root equals or contains the cwd. Not a violation; audited as `<temporary directory>`.
- **Outside or unresolved:** anything else, empty observations, the change-set overflow sentinel, and invalid in-workspace paths. Audited as `<outside workspace>`; these are violations.

An out-of-claim native file-tool write marks the writer `writeViolationOffender`, records the paths in its write audit and a system warning, and stops only that writer through the normal subtree stop. Peers keep running, admission continues, and its claims are freed once cleanup is confirmed. A likely mutating Bash command only increments a bounded heuristic count.

Claims are cooperative, not filesystem isolation. Comparison is lexical after NFC normalization and case folding, so symlinks and hard links are not resolved. Native edit, write, and Bash can modify the whole cwd, and observation is post-hoc: a violating write may land before the stop, and nothing rolls it back.

### Leases

Writer leases use pi-cosmic-core's `CrossProcessLock` under `<agent-dir>/subagents/writer-leases-v3`, namespaced by the identity digest; neither slot name nor evidence exposes the path.

- `acquire` makes one non-waiting `tryAcquire`. A live owner is a `live` conflict; a dead native-pending owner, corrupt evidence, or an unsafe root mode is `recovery-required`. Conflict messages never name the other session's run, session, or process.
- `markSpawnStarted` commits before any driver call, so parent death afterward requires manual recovery: detached process groups may survive. Recover only after verifying the backend and descendants are dead (`owner.json` names the owner's process), then remove the named lock directory.
- Every mark, settle, or release sets the lease phase to `uncertain` until its commit returns, so any failure keeps the slot held and quarantines the pool until restart.
- A pool created for a later respawn performs a fresh acquire and mark.
- Coordination assumes same-host Pi processes share one agent directory on a local filesystem with stable device/inode identity.

### Cleanup ordering and quarantine

- Stop and shutdown wait for every admitted spawn attempt to settle, close the backend scope once, and only then detach pool membership.
- Non-final members detach only after confirmed cleanup; only the final member authorizes lease release. A failed cleanup keeps the member attached, and an unconfirmed release keeps the whole pool quarantined with its process capacity and writer ownership.
- Cleanup quarantine is tracked per member, independently of claim violations; recovering one member never frees another, and healthy peers keep the lease.
- `cleanup` is absent until cleanup starts, then `pending`, `confirmed`, or `quarantined`, with a bounded redacted phase, reason, and `stop` or `manual` recovery policy.
- Stop verification is session-owned and single-flight. Only failures attested by the exact process transport are eligible; mixed finalizer failures, incomplete descendant evidence, and uncertain lease commits stay manual. Recovery never closes a closed scope, signals retained PIDs, rediscovers reparented descendants, or retries an uncertain lease commit. Confirmation requires the exact child's exit and absence of every recorded process group.

## Isolated workspace lifecycle

The parent's review and apply procedure is in the [reference](reference.md#reviewing-and-applying-worktree-proposals); this section owns the contract.

### Mode and admission

- A writer's mode is chosen at admission ([Public launch contract](routing.md#public-launch-contract)) and recorded; retries and revision successors keep it. Changing the session default affects only later launches, and settings show how many workspaces in this checkout remain unresolved.
- A `worktree` writer launches in a detached worktree in package-private state. Its cwd lease protects that directory, not the parent checkout.
- The root and active Pi worktree writers may start worktree writers ([Nested worktree writers](#nested-worktree-writers)); any other nested caller whose writer resolves to `worktree` fails with `workspace_nested_writer_unsupported`.
- Read-only runs never acquire workspaces, and nested readers inherit their parent's effective cwd, including a worktree.
- A worktree launch checks retry claim, parent, spend limit, and tree and direct-child capacity first, then holds one parent direct-child slot until admission or failure. Held slots count toward direct-child and tree limits. If running runs alone fill a limit, the launch fails at once; if only creating launches fill it, it waits interruptibly, holding nothing.
- The binding is recorded as soon as the engine acquires the workspace. A start that is never admitted frees its slot and discards the workspace; if that discard fails, the binding remains for the parent to discard. Admitted starts that fail keep their workspace as an ordinary proposal.
- A route retry of a worktree writer acquires a fresh workspace from its parent's current tree and never touches the failed writer's workspace.

### Snapshots

The engine (`workspace/service.ts` over `boundary/git-worktree*.ts`) keeps a standalone private bare repository holding a bounded snapshot of current source files. It never borrows the source object database or imports source history.

- **Captured:** every tracked file with its staged and unstaged contents, and untracked files with a source-like extension and a name that isn't credential-shaped (`.env*`, `.npmrc`, `secrets*`, `credentials*`, `*.pem`, SSH keys).
- **Excluded:** `node_modules`, `vendor`, `dist`, `build`, `coverage`, and `.pi` directories even when tracked (a file merely named `build` is captured), ignored files, and the excluded tracked paths, which the writer's task names.
- **Worker, prepared, and nested-source trees** hold only what a writer made, so their captures take every untracked file except excluded directories, unsafe names (control characters, `\`, `:`, `.git` components), and credential-shaped names without a source-code extension (`.env*`, `.npmrc`, `*.pem`, `*.key`, SSH keys, `credentials.json`, `secrets.txt`). `src/auth/credentials.ts` and other credential-named source stay captured, as does any file the baseline tracks.
- **Uncaptured worker files** are listed as `uncapturedPaths`. Those in excluded directories and credential files are left out on purpose: review lists them and prepare, apply, and export warn (`worker-files-left-out`, `credential-files-left-out`). Any other makes prepare and apply refuse with `workspace_uncaptured_files` until a revision leaves none.
- **Ignore rules** are the excludes file Git would use (repository-local `core.excludesFile`, followed includes, else the XDG default) plus `.git/info/exclude`, recorded in the private repository at creation. An unreadable excludes file or unrepresentable ignore configuration refuses the capture.
- **Credentials:** source captures (create, prepare, integrate) refuse a file whose new lines, compared against its stage-0 blob as a multiset, contain a private key block, AWS access key ID, GitHub token, or `sk-` key, naming the line. Untracked files are scanned whole; committed or staged content passes, and worker captures are not scanned. This guards against durable copies of uncommitted secrets; it is not a general detector.
- **Refused states:** bare repositories, repositories without a commit, sessions inside Git metadata, sparse checkouts, symlinked path components, case-mismatched on-disk names, skip-worktree or assume-unchanged entries, unmerged indexes, submodules inside the repository, hardlinks, special files, and oversized files. Each refusal names the path, rule, and remedy. Linked worktrees and submodule checkouts work as sources.
- **Symlinks** are preserved only when tracked, canonical, relative, and pointing directly at a separately captured regular file in the repository (such as `CLAUDE.md -> AGENTS.md`). Workers may change the target file, but symlink changes are rejected before integration.
- **Limits:** 4,000 files, 4 MiB per file, 32 MiB total, and 48 MiB per revision patch. Non-UTF-8 text is copied byte-exactly, but freeze refuses a revision that changes one, since review pages are text.
- **Byte exactness:** the private repository's `info/attributes` unsets `text`, `eol`, `crlf`, `filter`, `ident`, `working-tree-encoding`, `diff`, and `merge`, so no filter or driver runs.
- Captures hash files in-process and compute the Git tree ID themselves. Captures later operations need as objects go through one `git fast-import` stream and must match that ID; verification captures only compare it.

Native Pi tools keep local-user authority, so isolation is not a confidentiality boundary or sandbox. Excluded dependencies are absent unless the project declares a setup command.

### Setup and verification commands

A trusted project's `.pi/pi-subagents.json` may declare `workspaceSetup` and `workspaceVerify`, each `{ "command": [argv...], "timeoutSeconds"?: 1-3600 }` with a 600-second default. Global documents reject both. Changes apply after `/reload`.

- Both run without a shell, with the user's environment minus Git's repository-local variables, in their own process group with bounded output.
- **Setup** runs at the root of each new worker tree before the worker starts, again in the combined tree after `prepare` or before `apply`'s verification, and in a tree rebuilt by `revise` with `rebase`. Afterwards the tree must match its baseline apart from ignored or excluded files. Changed files, a non-zero exit, or a timeout fail with `workspace_setup_failed`; a failed preparation is withdrawn.
- **Verify** runs only during an `apply` without a preparation, after setup, and returns the last 40 lines (at most 4,000 characters). A tracked change fails verification and names the files. Manual `prepare` and applying a prepared pair never run it.
- The engine durably marks the tree before the command starts and clears the mark once its process group is confirmed stopped, including after interruption. Other operations refuse that workspace meanwhile; unrelated workspaces proceed, because the engine holds its locks only around marker writes.
- Unconfirmed cleanup (`workspace_verify_cleanup_unconfirmed` for verification) or a failed marker commit quarantines the artifact across runtime replacement until manual recovery.

For pnpm, `["pnpm", "install", "--offline", "--frozen-lockfile"]` installs from the local store, and workspace links resolve to the isolated tree's own packages.

### Review, apply, export, and revise

A final report changes no parent files and grants no approval. Only the authenticated direct parent integrates, and only through `subagent_workspace apply`. Both paths write uncommitted edits without changing the parent index, branch, or commits.

- **Quick path:** `apply` with only `workspaceId` freezes the current revision (an optional `revisionId` must match, else `workspace_revision_stale`), prepares it against current parent work, runs setup and verification when `workspaceVerify` is configured, and integrates that pair. Its result reports whether every review page was read (`reviewed`) and whether verification passed, failed, or isn't configured.
- **Careful path:** `review` freezes a cleaned-up proposal and pages its immutable text: a summary (diffstat, changed files, uncaptured paths) then the patch, never splitting a character. `prepare` builds the combined cwd; the parent tests there; `apply` with `revisionId` and `preparationId` integrates exactly that pair without preparing or verifying again, reporting `parent-tested`.
- **Partial apply:** `paths` limits the quick path to a subset of changed paths (`workspace_paths_unknown` names others). The engine keeps the worker tree and advances the baseline, so the next freeze proposes exactly the rest, and the binding returns to unreviewed. `paths` can't be combined with `preparationId`.
- **Failed verification** applies nothing. The preparation stays for inspection, but applying it as a prepared pair refuses with `workspace_verification_failed`.
- **Conflicts:** a patch that doesn't apply to current parent files fails `prepare` with `workspace_conflict`, naming the files, and removes the preparation tree. Integration refuses parent edits to proposal files (`workspace_parent_changed`), a changed branch or staged entries, a changed worker or test tree, and uncertain cleanup; parent edits to other files are kept and named in a warning.
- **Export** writes the current revision without resolving it: a binary patch under the source's common Git directory, or a branch built with plumbing through a temporary index (`read-tree HEAD`, `apply --cached`, `write-tree`, `commit-tree`, `update-ref` with an all-zero old value). The user's index, `HEAD`, and working tree never change. The branch commit carries the user's identity: `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, else `user.name` and `user.email` read with the user's Git configuration in the source repository. Only when neither names a role does it use `Pi workspace <workspace@invalid>`, and the result warns (`export-placeholder-identity`). Nested workspaces can't be exported.
- **Revise** starts a backend-neutral successor assignment whose admission makes the old review and preparation stale. With `rebase`, the engine first captures the worker, snapshots the source like a new launch, proves in a scratch tree that `git apply --3way` can run, then resets the worker in place (keeping its directory identity) and reapplies the changes. Conflicted files keep markers and are listed in the successor's task; a merge that can't run refuses with `workspace_rebase_refused` and changes nothing. A later failure restores the worker from its capture once the record names the previous baseline again (a rebuilt record whose save failed after landing is first replaced by the previous one); if the previous record can't be put back, the rebuilt worker is kept with its record, and either failure names `refs/pi/rebase-worker`, which holds the captured files.
- **Discard** deletes an unwanted proposal after cleanup.
- A frozen revision's patch lives in `revision.diff` beside the record. A record frozen by an earlier version kept it inline instead; the first read regenerates it from the private repository with freeze's diff options and saves it, under the checkout's store lock.
- Persisted details keep IDs, counts, paging metadata, verification status, and bounded command and failure text, never whole patches or command output.

### Binding states and resume

Each binding has exactly one state:

- `creating` (acquisition until admission or refusal) and `revising` (a revise call holds it for its successor) refuse other operations with `workspace_process_unsettled`.
- `busy` marks a root operation's hold; others fail with `workspace_operation_in_progress`.
- `idle` carries the current revision's knowledge: unreviewed, reopened (stale after resume or revision admission), frozen with review progress, or prepared with verification `tested` or `failed`.
- `stopped-integration` keeps source leases until discard rolls the publication back.
- `finished` records integrated, discarded, or discarded automatically.

Resume and revise never change the workspace before the writer is admitted.

- Resume validates everything, the binding included, in one locked claim. It refuses a busy binding, a binding a revision successor uses (`workspace_owner_unavailable`), a finished or mid-integration workspace (`workspace_finished`), and any worktree resume while integration is quarantined. A live process resumes in place; otherwise the reviewed revision becomes stale.
- Revise checks the binding, child workspaces, quarantine, nesting, and capacity under the run lock, then holds the binding. The successor's launch takes over that hold first, so an abandoned call doesn't release it. Admission commits the revision; refusal leaves the review, preparation, and earlier request unchanged.
- While a revision is stale, reviewing the old revision fails with `workspace_revision_stale`, applying the old pair with `workspace_preparation_stale`, and the next review freezes a new revision. Otherwise a review without `revisionId` returns the current frozen revision from offset 0.

### Concurrency

- Review and prepare queue on the coordinator's workspace operation lock, mark the binding busy, and call the engine outside the run lock.
- Integration and discard queue on the same lock and hold the run lock through occupancy checks and destructive engine work, so they may briefly delay unrelated run mutations.
- Apply keeps the binding busy throughout but releases the operation lock while verification runs.
- Integration refuses with `workspace_target_busy` only while a shared-checkout writer is active, cleaning up, or launching in an overlapping cwd. Worktree launches don't block it, because the engine's checkout lock orders their snapshots.
- Discard refuses while any run holds a directory within the artifact.
- Every mutating engine operation holds a `CrossProcessLock` keyed by the real checkout root at the top of the record's nested chain, under `<agent-dir>/git-workspaces/locks`. Waits poll interruptibly for up to two minutes, then fail naming the owner process; a dead owner's lock is reclaimed. Listing takes no lock.
- Git is resolved once per process (`/usr/bin/git`, else the first absolute `git` on `PATH`), must be 2.31 or later, and runs isolated calls without global or system configuration.

### Publication and rollback

Integration leases every existing ancestor of each touched file, rechecks source and preparation evidence, and saves the record once with a journal of planned directories and file changes. Publication then runs in-process.

- Before saving the journal it resets `publication.json` to zero, and before each step it fsyncs the count of started entries, so later entries are known untouched.
- Before each change it rechecks with `lstat` that every ancestor is still a real directory with the device and inode it saw.
- New files are written to a `.pi-workspace-new-<id>` sibling. A replaced or deleted file moves to a `.pi-workspace-old-<id>` backup checked against the reviewed preimage. Installation uses an exclusive link, so a competing destination is never clobbered.
- Publication is not an atomic multi-file transaction. Backups stay until the record says integrated (or, after a partial apply, active again), then are deleted; an undeletable backup is a warning. Both records keep the journal. If that save fails, the record is reread: one that landed despite a failed directory sync commits the publication, and otherwise the workspace stays mid-integration with every backup in its journal. Directories that deletions left empty are removed, never the source root or session directory.
- The source index identity is a digest of staged entries, so `git status` stat refreshes don't count as changes.

A conflict, failure, or crash leaves the workspace mid-integration with its journal, backups, and temporary files, holding its source leases so no shared-checkout writer edits those directories. Other writers and integrations proceed.

The owning session's `discard` rolls it back from disk: for every started entry it deletes the temporary file, removes an installed file that still holds the published content, restores a backup that still holds the preimage, drops an empty backup reservation whose file never moved there, then removes created directories once empty. If any started entry matches neither side, rollback changes nothing and refuses with `workspace_rollback_refused`, naming each file. Another session's discard refuses a mid-integration workspace; recover it manually from the journal.

`workspace_integration_quarantined` refuses integration only while the session is quarantined, after a failed source-lease release or an unreadable integration outcome. Writer admission and integration then stay quarantined until Pi restarts.

After a committed integration the engine removes the proposal's `prepare-*` trees and worker tree, keeping trees a live run still uses. The worker tree also stays, with a `worker-retained-for-children` warning, while workspaces created from it are unresolved. A failed removal is a warning.

### Automatic cleanup

After a `completed` worktree writer's cleanup is confirmed, a session-owned fiber compares its worker tree with the baseline.

- With no changed or uncaptured files and no unresolved child workspaces, it discards the workspace and records `workspaceOutcome: auto-discarded`. Resuming that writer fails with `workspace_finished`.
- Otherwise it records a `proposal` with changed and uncaptured counts and a bounded diffstat: line totals and the first 20 files (paths clipped to 256 characters; condensed cards keep only totals).
- Failed and stopped writers, and workspaces that are busy, resumed, revised, reviewed, prepared, in use, or fail inspection, are kept.
- This never delays report delivery or `subagent_await`. Resume or revision admission clears a recorded outcome.

### Orphans and collection

Crash or reload artifacts are never adopted. Each record names the owner lease its creating engine holds until its runtime closes; a free lease proves that session ended.

- Another session's root may then `export` the orphan read-only, or `discard` it. Discard first takes the original writer lease whose filesystem identity the workspace saved, and requires the worker path to still resolve to that directory, rechecked immediately before each removal.
- Preparation trees are removed before the worker, and discard is recorded only after editable trees are gone.
- Mid-integration workspaces, records without owner or writer-identity evidence, records with pending setup or verification cleanup, records with unresolved children, and unreadable records are never discarded this way.
- At startup each runtime collects discarded and integrated records a week after their last change, under their checkout's lock, unless an editable tree remains or a nested record names it as its source. Unreadable records block collection.
- Listing separates valid records from fixed-size unavailable-artifact diagnostics; one unreadable record never hides healthy neighbors. Root listings keep unknown artifacts without inferred metadata; nested listings show only exact-owner records. Visibility grants no mutation authority.

For manual recovery, confirm every writer process and descendant is dead, preserve the proposal and journal, and compare partially published paths against the journal and local work. Never remove a private Git directory or lease solely because the parent PID exited.

### Nested worktree writers

An active local Pi worktree writer may start worktree writers of its own. The coordinator judges this only from the caller's authenticated run record: an active Pi writer in worktree mode with an unfinished binding.

- Its writer children default to `worktree`; explicit `isolation: "shared-checkout"` starts an ordinary writer in the caller's worker tree.
- A nested workspace snapshots the caller's worker tree, uncommitted work included, and belongs to the caller, which applies it into its own worker tree. Integration skips the lease the caller's pool already holds.
- Only such workspace parents receive `subagent_workspace` and guidance to resolve every child workspace before reporting. `PI_SUBAGENT_WORKSPACE_PARENT=1` is a tool-surface hint, not authority; every proxied call is rechecked.
- A private source must be exactly an active workspace's worker tree or a directory in it; prepare trees, private repositories, other workspaces, and chains deeper than eight are refused. Private sources use only their recorded ignore rules and aren't credential-scanned. A child prepares and integrates only while its source is active, frozen, or prepared.
- While a workspace has unresolved or creating children, its review, prepare, apply, revise, and discard fail with `workspace_children_unresolved`.
- Once a child's direct parent is terminal with confirmed cleanup, the root or an ancestor of that parent may discard the child, but never review, apply, or revise it; if the parent's record is gone, only the root may. Nothing cascades.
- Listing attributes nested records to their real checkout, and collection keeps records a nested record names as its source.

## Private state housekeeping

Local Pi run directories (`<agent-dir>/subagents/<session>/<run>-<runtime suffix>`), local CLI harnesses (a Codex harness holds a copied `auth.json` and thread rollouts), supervisor channel state, and Claude temp roots (`/tmp/pi-claude-XXXXXX`) each carry an `owner.json` naming the root Pi process and its start identity.

- Normal cleanup removes them. Each root session start sweeps the rest in the background: an entry goes once its owner is provably dead, or once it is unchanged for seven days without a provably live owner.
- Removal renames to a `.swept-` tombstone first, so a concurrent Pi never reads a half-deleted directory. Failures are skipped.
- In `/tmp`, the sweep considers only real directories matching `pi-claude-` that the current user owns.
- The runtime suffix prevents a resumed session's restarted run IDs from reusing an earlier process's directory.
- The sweep never touches reports, writer leases, debug ledgers, workspaces, or unrecognized directories, and nested children never sweep.

## Supervisor channel and completion ownership

Local Claude and Codex each acquire one authenticated supervisor channel inside their backend scope; local Pi uses its RPC/IPC transport instead.

### Completion

- **Pi:** only `agent_settled` decides the outcome, using the latest assistant attempt's bounded text and stop reason. A successful `stop` with nonempty text completes. Provider errors, unrequested aborts, output limits, tool-use-only endings, and empty reports fail. Before that, the child bridge gives a textless final message one hidden reminder to write its report; earlier messages are never promoted to the report.
- **Claude and Codex:** completion belongs exclusively to a supervisor `supervisor_submit_report` call. Raw CLI text and native turn completion don't settle the assignment. The channel records exact accepted-report epoch evidence before acknowledging, and Claude results and Codex `turn/completed` query it directly, so causality, not scheduling, decides a missing report.
- The first turn that ends without an accepted report gets one automatic reminder input in the same assignment. A second miss, or an unsendable reminder, fails with the latest turn's final text, bounded to 2,000 characters.
- If transport closes before forwarding drains, the adapter reprojects the accepted report. Interruption emits no completion-shaped event.
- Every candidate closes on report, so acceptance closes the process and channel immediately while keeping bounded projection data. Nothing is written into the project.
- Failures can leave completed writes behind; continuation is an explicit frozen-route retry after confirmed cleanup.

### Report events and channel

- The backend-neutral report event carries run, assignment epoch, a positive monotonic sequence, a bounded `deliveryId`, and optional ownership evidence, validated in one serialized commit. Exact `(sequence, deliveryId)` retries are idempotent; higher reports while idle are rejected without advancing the watermark.
- The channel binds only IPv4 loopback on an ephemeral port and writes one 0600 connection document in a 0700 run directory. A 256-bit token authenticates every RPC through HMAC with a non-extractable key; peers are loopback-checked and capped, and every payload, frame, queue, and string is bounded. Malformed frames close the peer.
- Each connection has an authentication deadline. The channel's single release runs once, uninterruptibly, closing peer sockets and the server before removing private state.
- Event admission reserves cancellation capacity for the pending question and every admitted proxy RPC.
- The standalone helper (`supervisor-mcp-helper.mjs`, run through Jiti from installed `node_modules`) exposes only `supervisor_progress`, `supervisor_warning`, `supervisor_question`, and `supervisor_submit_report`. It dispatches up to 16 calls concurrently, so a blocked question never blocks other calls. Each call commits exactly one JSON-RPC frame after its operation's exit, and the writer closes before active calls and sockets.
- `supervisor/mcp-contract.ts` owns tool names, argument keys, and the 16,384/32,768/256-character bounds. Patterns are enforced when decoding, not advertised in input schemas, which some providers reject. A rejected call names the failing argument and rule without echoing values.
- Config reads and state cleanup stay on the Node boundary because Effect FileSystem lacks `lstat` and `O_NOFOLLOW`. MCP and Codex stdio use the shared byte-bounded line parser, because `Stream.splitLines` has no size bound.
- Helper metadata contains only the fixed packaged command, the private config path, and Claude JSON/Codex TOML fragments: no profile fields, user configuration, credentials, or environment.

### Native sub-agents and main-agent-only tools

Native sub-agents can reach the child's supervisor tools: Claude sub-agents share the child's MCP connection, and Codex starts a helper per sub-agent thread. `supervisor_question` and `supervisor_submit_report` belong to the child's main agent; a sub-agent's call fails with a tool error telling it to return its findings to the agent that started it. Progress and warnings stay open to sub-agents.

The caller is identified at the call, never from output ordering:

- **Claude:** initialization registers an SDK `PreToolUse` hook for the two tools. Hook input carries `agent_id` only for a native sub-agent, and the driver denies those calls. Managed settings that disable hooks may disable this check.
- **Codex:** the helper forwards the request's `_meta.threadId`, and the channel refuses any thread other than the main thread registered from `thread/start`. A call without `_meta.threadId` is admitted, so older supported releases still report.

## CLI versions

- Claude Code routes require 2.1.224 or later, the first release with the `crossSessionInbound` setting the harness uses to refuse cross-session input.
- Codex routes require 0.145.0, the app-server v2 subset the adapter was generated from; `--strict-config` rejects older releases.
- Each `LocalCliProcess` runs `<cli> --version` once per session and caches the answer; an unavailable CLI is probed again next preflight. The first dotted `major.minor.patch` triple is the version.
- Below the minimum, preflight fails with `<runtime>_version_unsupported` and routing moves to the next candidate. Unrecognized output never blocks a launch.
- Codex native sub-agent items follow the 0.162.1 app-server schema, which adds `subAgentActivity` items and collaboration tools to the 0.145 subset.

## Local Claude

### Launch and sandbox

Local Claude starts only `claude --print --input-format stream-json --output-format stream-json --verbose --forward-subagent-text`, with partial and replayed messages, empty setting sources, strict MCP, explicit model and effort, no session persistence, and no slash commands or plugins. The subagent prompt is appended with `--append-system-prompt-file`, keeping Claude Code's native system prompt. `--safe-mode` is not used because it removes the required stdio MCP path.

- Generated settings refuse cross-session input, because headless children contact the parent only through the supervisor channel.
- Every launch requires strict sandbox settings: enabled, failure when unavailable, no unsandboxed fallback, an empty network allowlist, and an assigned-cwd write policy. Unsupported platforms fail with `claude_shell_confinement_unsupported`, unsupported writer paths with `claude_writer_confinement_unsupported`.
- Read-only children get sandboxed Bash for inspection, with Edit, Write, and NotebookEdit excluded and Bash writes to the cwd denied. Writers also get Edit through one canonical-cwd-scoped rule; bare Bash, Edit, or Write are never granted.
- `Agent`, `Task`, `TaskOutput`, `TaskStop`, and `SendMessage` are allowed. Their work stays inside the Claude process tree under the same policy and lease and updates only the run's native activity summary.
- Edit is the CLI's path-enforced permission policy, not an OS sandbox, and web and model traffic are not a confidentiality boundary.

Claude Code keeps temp files in `$CLAUDE_CODE_TMPDIR/claude-<uid>`, which defaults to `/tmp/claude-<uid>` shared with the user's other sessions. Each child instead gets a fresh 0700 root from `mkdtemp("/tmp/pi-claude-")` with its own owner record, and `CLAUDE_CODE_TMPDIR`, `TMPDIR`, `TMP`, and `TEMP` point there.

- The root lives in `/tmp` because Claude Code gives sandboxed Bash `<root>/claude-<uid>` only while that path fits in 44 bytes; otherwise Bash falls back to the shared directory.
- Generated settings deny writes to the shared `/tmp/claude-<uid>`, so a fallback fails instead of leaking. `/tmp` and the parent's `$TMPDIR` stay read-only.
- A read-only Claude child can therefore write only its own private temp directory.

### Initialization and input correlation

- Startup sends the initialize control, then one `shouldQuery:false` input to obtain `system/init` without inference. It validates cwd, session, resolved model, MCP errors, and a connected `pi_subagents_supervisor` inventory with all four tools. Initialization and start have 60-second deadlines, and initialization failure is post-spawn, never candidate fallback.
- Every outbound input carries a fresh UUID, and acknowledgement requires native replay of exactly that UUID from the active session. Delayed duplicates of confirmed UUIDs are acknowledged silently from the same session only.
- User frames with a non-null `parent_tool_use_id` are native-agent forwarding: their text becomes activity, and forwarded tool results keep the nested lifecycle used by claim observation.
- Claude-owned synthetic `task-notification`, `auto-continuation`, and `peer` messages own a subturn inside the active assignment. Replayed `<task-notification>` commands are accepted only as complete same-session, active-assignment, text-only envelopes; near misses, qualified subkinds, channel or peer origins, and cross-session delivery fail closed.
- An unexplained top-level replay before report acceptance is a protocol error. After an accepted report, it instead emits a bounded metadata-only warning and reprojects the report so completed work is preserved.

### Background continuations

Claude Code ends a turn while background agents or shells run and starts a new one when their notification arrives. The adapter tracks `system/background_tasks_changed` and `system/task_notification`. A turn that ends without a report waits for that continuation while background tasks run or a notification arrived; with nothing running it allows 20 seconds before the missing-report path. After settlement, notification turns only contribute usage.

### Steering

- The ten-second caller wait is separate from backend-owned delivery. A timeout returns `steer_outcome_uncertain` with the typed `pendingDelivery` flag, without terminating Claude ([Tool result certainty](completion-delivery.md#tool-result-certainty)).
- While unresolved, further input and queue-cancelling interrupts are rejected; stop remains available. Only an exact same-session replay confirms guidance, and a monotonic sequence keeps stale events from resolving newer input.
- An absolute five-minute watchdog from delivery ownership checks for an accepted report, then closes admission and terminates the backend. This bounds liveness; it does not prove Claude unhealthy. Nothing resends input.
- An accepted report takes precedence over unconfirmed guidance and completes with `report-unconfirmed`. Failed or stopped runs with pending guidance keep `unresolved`, which blocks retry and retry hints.
- Typed primary failures survive exit. A failure snapshot holds only timing, frame and tool categories, a validated CLI version, and the termination reason.

### Native results and interruption

- Results correlate to their input by `user_message_uuid`, otherwise by issue-order FIFO. The initialization probe's result is a nonfatal artifact.
- Usage comes from each result's running `modelUsage` (which includes native agents and compaction) and `total_cost_usd`. A result contributes only the increase over what the process has counted, zeroed crash results never lower the watermark, and a regressing total warns.
- Accepted reports wait up to ten seconds for the native result or exit, so usage lands before the scope closes; timeout or exit flushes the report. The trailing-unknown-replay path skips this grace.
- Interrupt sends `cancel_queued:true` and stays owned until the control response, replayed marker, and `error_during_execution`/`aborted_streaming` result all arrive, in any order. After an uncertain public timeout a second interrupt is rejected, and a late marker and result settle through `run_settled` as a pause. Transport closure clears lingering ownership.

### Diagnostics

`PI_SUBAGENTS_CLAUDE_DEBUG=1` enables a metadata-only replay ledger: at most 512 entries and 64 KiB per scope in a 0600 `replay-ledger.ndjson` below `<agent-dir>/subagents/local-claude-debug-v1/`, retaining at most eight directories. It stores no prompt or result text, native IDs, paths, or tool arguments, and diagnostic failures never change run behavior. Claude's raw `--debug-file` is never enabled.

For a live reproduction that may incur provider usage, set `PI_SUBAGENTS_REAL_CLAUDE_MODEL` and run `pnpm --filter pi-subagents smoke:local-claude-replay`.

### Live steering timing probe

The opt-in probe can incur provider usage; its 120-second bound is not a spending limit. Capture `claude --version`, then run one scenario without retries:

```bash
PI_SUBAGENTS_REAL_CLAUDE_MODEL='<native model selector>' \
PI_SUBAGENTS_REAL_CLAUDE_STEERING_SCENARIO=generation \
pnpm --filter pi-subagents smoke:local-claude-steering
```

Scenarios are `tool` (default, foreground `sleep 25`), `generation`, and `native-agent`. The probe sends one guidance input after observed activity, distinguishes confirmed or late replay from completion with unconfirmed guidance, and reports missing activity as inconclusive. A ten-second replay miss alone is not proof of a failed worker.

## Local Codex

### Launch and harness

- Local Codex starts only `codex app-server --stdio --strict-config` against an isolated 0700 `CODEX_HOME`. Native agents (`[agents]`, `multi_agent`) are enabled within Codex's limits; apps, plugins, hooks, skills discovery, memories, browser, image, web search, and network are disabled.
- Only a bounded, validated `auth.json` is copied from the source `CODEX_HOME` into 0600 private state, without passing the source path to the child; otherwise the fixed `OPENAI_API_KEY` fallback applies. Unconfirmable partial harness cleanup returns `harness_cleanup_unconfirmed`.
- `thread/start` passes the subagent prompt as `developerInstructions` and starts a persistent thread, because a context-forking native sub-agent loads its parent's rollout. Rollouts and the thread database live only in the private home, so harness cleanup and the sweep remove them. Nothing resumes a Codex thread.
- `thread/start` and `turn/start` omit `environments`, so Codex uses its default local environment.
- Fast candidates send `serviceTier: "priority"` on both calls, and initialization fails unless `thread/start` confirms it. Provider fallback is disabled, and the exact model returned by `thread/start` is verified before a turn.
- Effort is limited to minimal, low, medium, high, xhigh, and max.

### Sandbox

- Approval is `never`. The sandbox is read-only or workspace-write with network disabled; server-initiated approval requests are protocol violations. The supervisor helper intentionally runs outside the sandbox.
- Writer turns set `excludeSlashTmp` and `excludeTmpdirEnvVar`; the only writable root besides the cwd is the run's private 0700 `tmp` directory, which the generated `[sandbox_workspace_write]` default matches.
- `TMPDIR`, `TMP`, `TEMP`, and the shell's `TMPPREFIX` point there. Read-only children cannot write it either.

### Protocol

- The accepted v2 subset is `initialize`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, their responses, and relevant bounded notifications.
- Only `commandExecution`, `fileChange`, `mcpToolCall`, and `webSearch` items own a tool lifecycle. `fileChange` entries keep every source path and move destination for claim observation, and a claimed writer's file mutation without a path fails closed as a violation.
- `agentMessage`, `reasoning`, `collabAgentToolCall`, `subAgentActivity`, and unknown informational items surface as activity; unrecognized fields and kinds there are ignored, but an item without an ID fails the protocol. Turn, usage, report, and tool notifications decode strictly.
- An uncertain interrupt keeps its exact turn and epoch; a second interrupt is rejected, and a late interrupted completion settles through `run_settled` as a pause.
- `thread/tokenUsage/updated` reports only its own thread, and native sub-agents run in their own threads, so the adapter keeps a running-total watermark for up to 64 threads. Codex reports no cost, so cost stays unknown rather than `$0`.

### Live sandbox canaries

Opt-in canaries check that the installed CLIs still enforce the generated policy. They can incur provider usage:

```bash
PI_SUBAGENTS_REAL_CLAUDE_MODEL='<native model selector>' pnpm --filter pi-subagents smoke:local-claude-sandbox
PI_SUBAGENTS_REAL_CODEX_MODEL='<native model selector>' pnpm --filter pi-subagents smoke:local-codex-sandbox
```

Each runtime launches a read-only and a writer child in a fresh `workspace` directory beside an `outside` sibling. The child attempts Bash redirects inside and outside its cwd, into `/tmp`, into the parent's `$TMPDIR`, and into its private temp directory (Claude also tries the shared `/tmp/claude-<uid>`), then file-tool edits inside and outside its cwd.

- Read-only children must change nothing, except that a Claude child must succeed in its private temp directory.
- Writers may change only files in their cwd and private temp directory, and must succeed there.
- A write where it should be blocked is a security failure; missing evidence is inconclusive. Codex emits no item notifications for sandbox-denied attempts, so the canary relies on the child's report for them.
