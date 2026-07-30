# Architecture

`pi-herdr` is an Effect-managed Pi extension that controls persistent read-only Claude Code instances hosted by an existing Herdr server. Herdr owns PTYs and Claude process lifetime; Pi owns only session-local monitors, waiters, tools, UI projection, configuration access, and durable ownership records.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/application.ts` — generation-based session activation, cooperative tool registration, command wiring, and Pi-side shutdown.
- `src/layer.ts` — Effect composition root.
- `src/config/schema.ts` — versioned config and private ownership-state shapes.
- `src/config/options.ts` — bounded option normalization.
- `src/config/store.ts` — the single persistence door for global/trusted-project configuration and private agent-directory ownership state.
- `src/boundary/herdr-client.ts` — bounded, interruptible Herdr CLI adapter and fixed read-only Claude launch policy.
- `src/boundary/report-channel.ts` — private run-directory/MCP-config preparation and schema-decoded report reads.
- `src/boundary/report-helper.mjs` — standalone stdio MCP helper launched as a Claude child; atomically writes one bounded idempotent report.
- `src/boundary/state-lock.ts` — same-host cross-process state/resource lock using atomic private-directory acquisition, PID liveness checks, orphan reclamation, bounded waiting, and ownership-token-checked release.
- `src/boundary/host-ui.ts` — synchronous immutable projection/footer bridge.
- `src/herd/model.ts` — run, Herdr topology, and projection contracts.
- `src/herd/errors.ts` — schema-backed expected failures.
- `src/herd/protocol.ts` — Effect Schema decoding and Herdr wire translation.
- `src/herd/coordination.ts` — pure prompts, workspace selection, split selection, and persistence projection.
- `src/herd/workspace.ts` — managed workspace/tab validation and non-focusing acquisition.
- `src/herd/reconcile.ts` — serialized remote/report reconciliation and retention.
- `src/herd/projection.ts` — pure sorting and footer summaries.
- `src/herd/service.ts` — sole run registry, serialized mutation owner, persistent topology reconciliation, report ingestion, revision waiters, and monitor fiber.
- `src/tools/` — strict TypeBox contracts, bounded model-facing formatting, and seven cooperative-shell tools.
- `src/settings/controller.ts` — `/herdr` inspection/focus/stop command.

## Ownership

### Pi session ownership

One managed runtime starts from `session_start` and is disposed by `session_shutdown`, replacement, or tree navigation. Its finalizer stops only polling fibers and wakes Pi-side waiters. It never terminates Claude or closes a Herdr pane merely because Pi exits.

### Herdr ownership

The extension persists opaque session/workspace/tab/pane/terminal/name tuples under the Pi agent directory. Startup and state-changing Herdr operations are serialized across same-host Pi processes with a private atomic-directory lock, while `ProcessCoordinator` avoids redundant filesystem contention between runtimes in one process. Run saves merge by opaque ID; explicit `stopped` state is monotonic, and other terminal states outrank concurrent active snapshots before timestamp precedence is applied. The extension revalidates the complete tuple before destructive pane closure and never adopts or closes resources from cwd, label, or agent kind alone. A same-label foreign tab is not an ownership claim.

The managed tab is created lazily on the first agent start. Its root pane hosts the first Claude instance; only additional agents receive split panes, eliminating an unused anchor while agents are present. The persisted anchor ID follows an extension-owned agent pane. Reconciliation automatically closes panes after durable `completed` or `failed` reports, while failures without a report remain available for terminal inspection. Before closing the anchored pane, the service transfers the anchor to another revalidated managed agent pane or, when none remains, creates the replacement shell Herdr requires to keep the tab alive. Pane splitting uses the largest current layout rectangle when available, and automatic or explicit background-pane closure restores the previously focused user tab if Herdr moves focus. The same-host lock spans each complete topology mutation, including Herdr/Claude startup and anchor replacement; competing waits remain interruptible and time out after two minutes.

### Completion ownership

Claude starts with a private `herdr_report` stdio MCP server. The helper accepts exactly one bounded `submit_report` call, fsyncs and atomically renames `report.json`, and acknowledges only after durable storage. A later Pi session can ingest that receipt while the Claude/Herdr process continues independently. Terminal state is operational evidence only; a valid report is authoritative completion. The explicit MCP/strict-config path was verified against Claude Code 2.1.220 using subscription authentication, and the complete split/start/prompt/report/await/stop path was exercised against an isolated Herdr 0.7.5 protocol-17 server before the MVP implementation was accepted.

## Security

- Herdr executable and Claude kind are fixed; agent tools cannot supply argv, model, session, cwd, tool policy, or executable paths.
- Claude receives only Read, Glob, Grep, WebFetch, WebSearch, and `mcp__herdr_report__submit_report`.
- Bash, Edit, Write, notebook mutation, and recursive agent tools are explicitly denied with `permission-mode=dontAsk`.
- Project configuration is read only when trusted.
- Herdr JSON, report JSON, and persisted state are schema-decoded at unknown boundaries.
- CLI output is byte-bounded; report text is capped at 48,000 UTF-8 bytes.
- The MCP config and report files are private agent-directory state, never project artifacts.

Read-only is a Claude capability policy rather than an OS sandbox. Combining user-account filesystem reads with web tools creates an exfiltration channel if untrusted content prompt-injects the delegated agent. User and administrator hooks remain part of the Claude installation; `--safe-mode` cannot be used because it disables the required MCP channel, while `--bare` disables subscription OAuth/keychain auth.

## Lifecycle limitations

Herdr 0.7.5/protocol 17 is the minimum supported automation surface. Cold Herdr server restoration may replace PTYs or resume native Claude sessions independently; missing or ambiguous resources are marked unknown and never destructively adopted. Persistent Claude delegation belongs to `pi-herdr`; `pi-subagents` remains Pi-only.
