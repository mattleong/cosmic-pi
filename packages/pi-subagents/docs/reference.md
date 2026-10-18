# pi-subagents reference

Procedures and safety notes behind the [README](../README.md). [ARCHITECTURE.md](../ARCHITECTURE.md) covers ownership and lifecycle; the other files in this directory own the detailed contracts:

- [Routing](routing.md): configuration schema, candidate planning, launch contract, and retry.
- [Local backends](local-backends.md): Pi, Claude, and Codex drivers, writer pools, worktrees, and the supervisor channel.
- [Completion and delivery](completion-delivery.md): reports, waits, cancellation, presentation, and Activity.
- [Settings workspace](settings-workspace.md): profile editor, saved sets, delegation, nesting, and doctor.
- [Native Pi codemode scripting](native-codemode.md): read-only scripts with ordinary subagents.

## Starting and waiting

Good delegation candidates include reconnaissance of unfamiliar or multi-package code, external research beside local inspection, implementation planning, and independent review. Nested Pi children may select any configured profile.

For scoped parallel implementation, give shared-checkout writers exact claims, or isolate a writer with `isolation`:

```json
{
  "agents": [
    {
      "task": "Implement token parsing in the assigned source and test files.",
      "profile": "worker",
      "writes": ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"]
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
- A question returns the wait early so the parent can call `subagent_reply` and await again.
- Retry only a failed run, and repeat retry only on a failed successor. Use `generalist` only after `retry_route_exhausted`.
- A writer stopped for writing outside its claims is relaunched by the parent with corrected claims.

## Reviewing and applying worktree proposals

A completed writer's report does not approve its changes, and nothing applies them automatically. A completed writer that changed nothing has its workspace discarded once cleanup is confirmed. Otherwise its notification and status show the changed-file count and line totals for up to 20 files, and its direct parent takes one of two paths without asking for routine user approval. A worktree writer that started worktree writers does the same into its own worker tree before reporting. The engine contract is in [Isolated workspace lifecycle](local-backends.md#isolated-workspace-lifecycle).

### Quick path

For small or trusted changes, call `subagent_workspace` with `{"action":"apply","workspaceId":"..."}` after process cleanup. It freezes, prepares, runs the project's `workspaceVerify` when configured, and integrates as uncommitted edits in one call. The result says whether the diff was read and whether verification passed.

Failed verification applies nothing, and that preparation can never be applied. Inspect its prepared tree, then revise, discard, or take the careful path.

To take only part of a proposal, pass `paths` (exact changed paths from the review summary). The remaining changes stay in the workspace as an unreviewed proposal.

### Careful path

For risky changes:

1. Call `review` with the workspace ID after process cleanup. Keep the returned `revisionId` and read every page, passing it with each `nextOffset`. Each page holds up to 16,000 characters: first a summary (per-file line counts, binary, added, deleted, and mode markers, and uncaptured worker files), then the full diff.
2. Call `prepare` with the workspace ID and reviewed `revisionId`. This creates a separate cwd combining the proposal with current parent edits.
3. Run relevant tests in that cwd without editing it. Worker-only tests don't replace this pass.
4. Call `apply` with `workspaceId`, `revisionId`, and `preparationId`. It integrates exactly that pair as uncommitted edits, without preparing or verifying again, and reports `parent-tested`. It never merges, stages, or commits.

### Failures and recovery

- Worker files in `node_modules`, `vendor`, `dist`, `build`, `coverage`, and `.pi` are left out on purpose; review lists them and prepare and apply warn. Any other uncaptured file makes prepare and apply refuse with `workspace_uncaptured_files`.
- A conflicting patch fails prepare with `workspace_conflict`; a parent edit to a proposal file fails apply with `workspace_parent_changed`. Both name the files.
- If integration stops partway, `discard` rolls back what it published.
- A snapshot refusal names the file, rule, and remedy. Only lines the source index doesn't already hold are scanned for credentials, so staging a deliberate new fixture lets the snapshot proceed.

### Revise, export, and discard

- `revise` takes the workspace ID and concrete feedback in `message`, and starts a successor writer; await it, then apply or review the new revision.
- When parent files moved on under the proposal (a stale preparation or `workspace_conflict`), add `"rebase": true`. The writer's tree is rebuilt from the parent's current files with its changes reapplied by three-way merge, and the successor's task lists conflicted files. A rebase that can't run refuses with `workspace_rebase_refused` and changes nothing.
- `export` keeps a proposal outside private storage. `"format": "patch"` (default) writes a `git apply`-able patch to `<git-dir>/pi-subagents/<workspaceId>-<revision>.patch`. `"format": "branch"` creates `pi-subagent/<writer-name>`, one commit on `HEAD`, without touching the index, `HEAD`, or files; it is refused if the branch exists, or with `workspace_conflict` when the proposal doesn't apply to `HEAD` (use the patch then). Export freezes like `review` and leaves the workspace unresolved.
- `list` pages workspace metadata with an optional `offset`.
- A later session's root may export or discard an orphaned workspace once the creating session has ended and no writer holds its worker tree. This recovers proposals stranded by `/reload` or a crash. Nested workspaces can't be exported.

## Tool access and sandboxing

- Pi children receive the root's active tool snapshot; Pi read-only is a prompt and lease policy, not a sandbox ([Local Pi](local-backends.md#local-pi-ownership-and-safety)).
- Claude and Codex children run under their native sandboxes, which fail startup rather than run unsandboxed ([Local Claude](local-backends.md#local-claude), [Local Codex](local-backends.md#local-codex)).
- Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.
- Writer leases are shared across Pi processes on the same machine; a refusal that requires manual recovery names the lock directory to inspect ([Writer pools](local-backends.md#writer-pools-cooperative-claims-and-cross-process-safety)).

## See also

- Commands and tools: the [README](../README.md#usage); editor keys in [Profile editor](settings-workspace.md#profile-editor); fleet and Activity actions in [Activity provider and fleet](completion-delivery.md#activity-provider-and-fleet).
- Diagnosing Claude steering: [Tool result certainty](completion-delivery.md#tool-result-certainty) and the [live steering timing probe](local-backends.md#live-steering-timing-probe).
- Compact rows and issues: [Tool registration and compact presentation](completion-delivery.md#tool-registration-and-compact-presentation).
