# pi-subagents reference

Detailed behavior, configuration, and safety contracts behind the [README](../README.md). See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and lifecycle. The other files in this directory are the canonical sources for routing, backends, delivery, settings, and workflows; this page links to them and records only the facts they don't state.

## Implemented behavior

The run tree, nesting limits, delivery, and retention are documented in [ARCHITECTURE.md](../ARCHITECTURE.md) and [Completion and delivery](completion-delivery.md); the launch contract and route continuation in [Routing](routing.md); the Pi, Claude, and Codex drivers, supervisor channel, and writer pools in [Local backends](local-backends.md); and the persistent widget and tool cards in [Projection and delivery](completion-delivery.md#projection-and-delivery). Additional notes:

- Nested Pi can select any configured profile.
- A static green `Subagents` title anchors the persistent widget while compact progress segments carry start and await mode. A one-column inset keeps hierarchy rails green while await markers, state glyphs, and titles follow each run's state.
- Claude stream input is confirmed only by exact native replay; the CLI may apply guidance at its next safe turn boundary.
- Codex interruption waits for both the correlated JSON-RPC success and matching `turn/completed(status=interrupted)` in either order and emits no later settlement event.
- Native Claude/Codex do not advertise resume, rename, peer notice, or fork.
- Every Claude and Codex run may use native agents within that runtime's own limits; see [ARCHITECTURE.md](../ARCHITECTURE.md#invariants) and [Local Claude](local-backends.md#local-claude). Pi provides no native-agent controls.

## Configuration details

Layering, defaults, cross-field rules, legacy migration, and nesting precedence are documented in [Version-6 routing and nesting domain](routing.md#version-6-routing-and-nesting-domain). Additional notes:

Each document may contain at most 32 scope-local sets. Names are 1–64 characters, start and end with a letter or number, and may otherwise contain letters, numbers, spaces, `.`, `_`, or `-`. A set always contains `profiles`, which may be empty.

A route is exactly `"disabled"`, one candidate, or a non-empty ordered candidate array (maximum 32). Candidate fields are:

- required `host`: `local` only;
- `runtime`: `pi`, `claude`, or `codex`;
- `model`: a bounded native runtime selector; Pi uses `parent` or canonical `provider/model`, including registry-owned `@` context variants;
- `effort`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `default` means the profile's soft default, while `generalist` inherits the current parent effort and falls back to `high`;
- `context`: `fresh` or `fork`;
- `writeIntent`: `read-only` or `writer`;
- optional `openaiFastMode`, defaulting to false; when true, eligible Pi or Codex candidates request OpenAI's `priority` service tier;
- optional `closeOnReport`, omitted or `true` only.

Native selectors use one fail-closed 256-character grammar across config, settings, and all three local adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, including Pi registry context variants such as `cursor/gpt-5.5@1m`, plus Claude's optional exact long-context suffix such as `[1m]`.

Unknown root keys fail document activation. Diagnostics redact profile-set names.

The optional root boolean `ultracode` is described in [Ultracode switch](settings-workspace.md#ultracode-switch). A non-boolean value (including the string `"true"`) stops activation for that document; correct the JSON before reloading.

The legacy version-6 `automaticProfileRouting` and `scriptedWorkflows` keys are accepted but ignored; existing files are not automatically rewritten.

### Current Session and saved sets

Current Session and the saved-set library are documented in [Settings workspace](settings-workspace.md#current-session). Additional notes:

Current Session writes no project, global, or Pi session-history data.

### Repairing retired remote or stay-open configurations

The repair rules are documented in [Explicit configuration repair](settings-workspace.md#explicit-configuration-repair). Additional notes:

Existing documents are never rewritten automatically, and no credentials or standalone `pi-herdr-btw` settings are changed. The `host: "herdr"` and `closeOnReport: false` rejections apply to legacy v4/v5 documents as well as v6 and inherited Global routes in partial Project sets.

When replacing invalid routes in `/subagents profiles`, review model, effort, context, and write intent; native selectors need not transfer across runtimes. Reload or explicitly apply a valid saved set after persistent repair. There is no automatic local fallback, retention substitute, or credential migration.

If `/reload` encounters an in-memory Current Session handoff containing retired candidates, subagents remain inactive rather than inheriting a different local route. Start a fresh Pi session after repairing persistent settings; repeated reloads or tree navigation do not bypass this protection.

## Starting and waiting

The launch contract, delegation policy, and explicit retry are documented in [Public launch contract](routing.md#public-launch-contract) and [Explicit route continuation](routing.md#explicit-route-continuation); cancelled waits and report availability in [Completion and delivery](completion-delivery.md#cancelled-waits-and-report-availability). Additional notes:

Good delegation candidates include unfamiliar or multi-package codebase reconnaissance, external research that can run beside local inspection, implementation planning, and independent review.

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

Repeat retry only on a failed successor, and use generalist only after `retry_route_exhausted`. Use `subagent_await` rather than polling status; “finished” means the selected run has completed, failed, or stopped. A parent question returns early so the parent can call `subagent_reply` and await again.

## Reviewing and integrating worktree proposals

Writer workspace mode, admission, snapshot limits, revise, resume, and post-integration cleanup are documented in [Isolated workspace lifecycle](local-backends.md#isolated-workspace-lifecycle). The parent's procedure:

A completed writer report does not approve its changes. Its direct parent follows this workflow automatically, without asking for routine user approval:

1. Call `subagent_workspace` with `{"action":"review","workspaceId":"..."}` after process cleanup. Keep the returned `revisionId` and inspect every diff page, passing the same ID and each `nextOffset` back to `review`. Pages contain up to 16,000 characters and are not summaries.
2. Call `prepare` with the workspace ID and exact reviewed revision ID. This creates a separate cwd combining the proposal with current parent edits.
3. Run relevant tests in that combined cwd. Do not edit the prepared tree. Worker-only tests do not replace this combined test pass.
4. After review and passing tests, call `integrate` with the exact `workspaceId`, `revisionId`, and `preparationId`. It applies the proposal as uncommitted edits, preserving the parent index and local work. It does not merge a branch, stage, or commit.

For rejected changes, `revise` takes a workspace ID and concrete feedback in `message` and starts a successor writer; await that run and review again. `list` pages workspace metadata with optional `offset`.

## Tool access and sandboxing

The root tool snapshot, Pi read-only semantics, and Claude and Codex sandbox policies are documented in [Local Pi ownership and safety](local-backends.md#local-pi-ownership-and-safety), [Local Claude](local-backends.md#local-claude), and [Local Codex](local-backends.md#local-codex). Additional notes:

Unsupported Bash-sandbox platforms fail with `claude_shell_confinement_unsupported`, unsupported writer paths fail with `claude_writer_confinement_unsupported`, and unavailable sandbox dependencies fail selected startup rather than running unsandboxed.

Claude `--safe-mode` is not used because it removes the required stdio MCP path; empty setting sources, strict MCP, fixed tools, and validated native MCP inventory retain that helper while admin-managed policy can still apply. Codex uses its native read-only/workspace-write sandbox, while the adapter-owned supervisor MCP helper intentionally runs outside it. Allowed reads, model network access, runtime defects, and external services may still disclose data or have side effects.

## Native preflight safety

Readiness preflight, Claude initialization, and Codex effort policy are documented in [Candidate planning and host resolution](routing.md#candidate-planning-and-host-resolution) and [Local backends](local-backends.md). Additional notes:

Claude Code's zero-inference initialize response resolves aliases at selected startup, but account entitlement can still fail after selection; that failure does not fall through. Codex delegation-enabling and unknown effort values remain excluded. Codex disables provider fallback and verifies the exact model returned by `thread/start` before issuing a turn.

## Cross-process writer safety

Writer identity, the `CrossProcessLock` lease, spawn marking, manual recovery, and pool cleanup are documented in [Writer pools, cooperative claims, and cross-process safety](local-backends.md#writer-pools-cooperative-claims-and-cross-process-safety). Additional notes:

A new pool created for a later respawn performs a fresh acquire and mark. Conflict messages do not name the other session's run, session, or process.

**Upgrading from protocol v2.** Restart every running Pi session after upgrading. Older sessions cannot see v3 locks, so exclusion works only one way while old and new versions run side by side. A leftover `<agent-dir>/subagents/writer-leases-v2/<digest>.lease` slot for the same directory denies writer startup with a message naming its path. Remove it manually only after every older Pi session has exited.

## See also

- Commands and agent tools: the [README](../README.md#usage); profile editor keys in [Settings workspace](settings-workspace.md#profile-editor); the `/subagents` fleet and Activity actions in [Activity provider and fleet](completion-delivery.md#activity-provider-and-fleet).
- Scripted workflows: [Dynamic workflows](workflows.md#dynamic-workflows), [Opting in](workflows.md#opting-in), [Foreground codemode scripting](workflows.md#foreground-codemode-scripting), and the [workflow authoring guide](../skills/workflow-authoring/SKILL.md).
- Diagnosing Claude steering: [Tool result certainty](completion-delivery.md#tool-result-certainty) and the [live steering timing probe](local-backends.md#live-steering-timing-probe).
- Compact tool rows and issues: [Tool registration and compact presentation](completion-delivery.md#tool-registration-and-compact-presentation).
