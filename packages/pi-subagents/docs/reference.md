# pi-subagents reference

Procedures and safety notes behind the [README](../README.md). [ARCHITECTURE.md](../ARCHITECTURE.md) covers ownership and lifecycle; the other files in this directory own the detailed contracts:

- [Routing](routing.md): configuration schema, candidate planning, launch contract, and retry.
- [Local backends](local-backends.md): Pi, Claude, and Codex drivers, writer pools, worktrees, and the supervisor channel.
- [Completion and delivery](completion-delivery.md): reports, waits, cancellation, presentation, and Activity.
- [Settings workspace](settings-workspace.md): profile editor, saved sets, delegation, nesting, and doctor.
- [Native Pi codemode scripting](native-codemode.md): read-only scripts with ordinary subagents.

## Starting and waiting

Good delegation candidates include reconnaissance of unfamiliar or multi-package code, external research beside local inspection, implementation planning, and independent review. Nested Pi children may select any configured profile.

For scoped parallel implementation, give shared-checkout writers disjoint task scopes, or isolate a writer with `isolation`:

```json
{
  "agents": [
    {
      "task": "Implement token parsing in packages/auth/src/token.ts and its tests; leave other auth files to peers.",
      "profile": "worker"
    },
    {
      "task": "Implement typed authentication errors in packages/auth/src/errors.ts.",
      "profile": "worker",
      "isolation": "worktree"
    }
  ]
}
```

- Use `subagent_await` rather than polling status. "Finished" means completed, failed, or stopped.
- A question returns the wait early so the parent can answer it with `subagent_send` and await again.
- Retry only a failed run, and repeat retry only on a failed successor. Use `generalist` only after `retry_route_exhausted`.
- Set an item's `model` only when the user asks for a specific model. That launch tries only that model, so a failed run has nothing to retry.
- Shared-checkout writers in one cwd have no file claims and are not isolated from each other; scope their tasks so they don't overlap.

## Reviewing and applying worktree proposals

A completed writer's report does not approve its changes, and nothing applies them automatically. A completed writer that changed nothing has its workspace discarded once cleanup is confirmed. Otherwise its notification and status show the changed-file count and line totals for up to 20 files, and its direct parent takes one of two paths without asking for routine user approval. A worktree writer that started worktree writers does the same into its own worker tree before reporting. The engine contract is in [Isolated workspace lifecycle](local-backends.md#isolated-workspace-lifecycle).

### Quick path

For small or trusted changes, call `subagent_workspace` with `{"action":"apply","workspaceId":"..."}` after process cleanup. It freezes, prepares, runs the project's `workspaceVerify` when configured, and integrates as uncommitted edits in one call. The result says whether the diff was read and whether verification passed.

Failed verification applies nothing, and that preparation can never be applied. Inspect its prepared tree, then revise, discard, or take the careful path.

To take only part of a proposal, pass `paths` (exact changed paths from the review summary). The remaining changes stay in the workspace as an unreviewed proposal.

### Careful path

For risky changes:

1. Call `review` with the workspace ID after process cleanup. Keep the returned `revisionId` and read every page, passing it with each `nextOffset`. Each page holds up to 16,000 characters: first a summary (per-file line counts, binary, added, deleted, and mode markers, and credential files the worker left out), then the full diff.
2. Call `prepare` with the workspace ID and reviewed `revisionId`. This creates a separate cwd combining the proposal with current parent edits.
3. Run relevant tests in that cwd without editing it. Worker-only tests don't replace this pass.
4. Call `apply` with `workspaceId`, `revisionId`, and `preparationId`. It integrates exactly that pair as uncommitted edits, without preparing or verifying again, and reports `parent-tested`. It never merges, stages, or commits.

### What a worktree writer shares

A worktree writer's workspace is a locked, detached linked worktree of your repository under `<agent-dir>/subagent-worktrees/`, so `git worktree list` shows it and its commits live under `refs/pi/workspaces/`. Discard and integration remove both. The writer's prompt tells it to stay on the detached HEAD and not to create branches, use `git stash`, change Git config, or run `git worktree` commands, because each would reach your repository ([Writer guidance](local-backends.md#writer-guidance)).

Ignored and untracked credential files stay in your checkout. When writers need some of them, such as `.env`, a trusted project's `.pi/pi-subagents.json` can name them with gitignore-syntax patterns; matching files are copied into each worker and test tree, but never into a proposal ([Included files](local-backends.md#included-files)). Run `/reload` after changing it.

```json
{
  "version": 6,
  "workspaceSetup": { "command": ["pnpm", "install", "--offline", "--frozen-lockfile"] },
  "workspaceInclude": [".env", ".env.local", "config/*.local.json"]
}
```

### Failures and recovery

- Ignored worker files never enter a proposal. Untracked credential files a writer created (`.env*`, `.npmrc`, `*.pem`, SSH keys) are left out on purpose; review lists them and prepare and apply warn.
- A conflicting patch fails prepare with `workspace_conflict`; a parent edit to a proposal file fails apply with `workspace_parent_changed`. Both name the files.
- A proposal file the parent index marks skip-worktree or assume-unchanged fails prepare and apply with `workspace_local_override`, naming the files; clear the bit with `git update-index` or revise the workspace.
- If integration stops partway, `discard` rolls back what it published.
- A refusal names the file, rule, and remedy.

### Revise and discard

- `revise` takes the workspace ID and concrete feedback in `message`, and starts a successor writer; await it, then apply or review the new revision.
- When parent files moved on under the proposal (a stale preparation or `workspace_conflict`), add `"rebase": true`. The writer's tree is rebuilt from the parent's current files with its changes reapplied by three-way merge, and the successor's task lists conflicted files. A rebase that can't run refuses with `workspace_rebase_refused` and changes nothing.
- `list` pages workspace metadata with an optional `offset`.
- Workspaces stranded by `/reload` or a crash become orphans once their session has ended, and `list` marks them `adoptable` or `discard-only`. From a later session's root, `review`, `prepare`, `apply`, or `revise` on an adoptable one takes it over, provided no writer holds its worker tree and no child workspace is unresolved; its first `revise` starts a new writer with the original profile or custom agent and your `message` as the task; if that agent is no longer configured, revise fails with `workspace_launch_unavailable`, and you can still apply or discard it. Nested and mid-integration orphans can only be discarded, which rolls back an interrupted integration.
- Orphans unchanged for 30 days are discarded when a root session starts in their checkout. Their patch stays at the path the start-up notice names for 7 days; apply it with `git apply` in its checkout to recover the work.

## Tool access and sandboxing

- Pi children receive the root's active tool snapshot; Pi read-only is a prompt and lease policy, not a sandbox ([Local Pi](local-backends.md#local-pi-ownership-and-safety)).
- Claude and Codex children run under their native sandboxes, which fail startup rather than run unsandboxed ([Local Claude](local-backends.md#local-claude), [Local Codex](local-backends.md#local-codex)).
- Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.
- Writer leases are shared across Pi processes on the same machine; a refusal that requires manual recovery names the lock directory to inspect ([Writer pools](local-backends.md#writer-pools-and-cross-process-safety)).

## See also

- Commands and tools: the [README](../README.md#usage); editor keys in [Profile editor](settings-workspace.md#profile-editor); fleet and Activity actions in [Activity provider and fleet](completion-delivery.md#activity-provider-and-fleet).
- Diagnosing Claude steering: [Tool result certainty](completion-delivery.md#tool-result-certainty) and the [live steering timing probe](local-backends.md#live-steering-timing-probe).
- Compact rows and issues: [Tool registration and compact presentation](completion-delivery.md#tool-registration-and-compact-presentation).
