# Architecture

`pi-herdr` is an Effect-managed Pi extension that controls persistent read-only Claude Code, Pi, and Codex instances hosted by an existing Herdr server. Herdr owns PTYs and agent process lifetime; parent Pi owns only session-local monitors, waiters, tools, UI projection, configuration access, private harness/report files, and durable ownership records.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/application.ts` — generation-based session activation, cooperative tool registration, command wiring, and Pi-side shutdown.
- `src/layer.ts` — Effect composition root.
- `src/config/schema.ts` — versioned config and private ownership-state shapes, including state-v1 Claude migration.
- `src/config/options.ts` — bounded option normalization.
- `src/config/store.ts` — the single persistence door for global/trusted-project configuration and private agent-directory ownership state.
- `src/boundary/herdr-client.ts` — bounded, interruptible Herdr CLI adapter and fixed per-kind read-only launch policies.
- `src/boundary/agent-harness.ts` — private Pi session and isolated Codex-home preparation, authentication reuse, and installed-integration validation.
- `src/boundary/report-channel.ts` — private run-directory/MCP-config preparation and schema-decoded report reads.
- `src/boundary/report-helper.mjs` — standalone stdio MCP helper; atomically writes one bounded idempotent report.
- `src/boundary/host-report-extension.ts` — sole bundled extension loaded into delegated Pi; exposes one cooperative-shell report tool backed by the same MCP helper.
- `src/boundary/state-lock.ts` — same-host cross-process state/resource lock using atomic private-directory acquisition, PID liveness checks, orphan reclamation, bounded waiting, and ownership-token-checked release.
- `src/boundary/host-ui.ts` — synchronous immutable projection/footer bridge.
- `src/herd/model.ts` — agent-kind, run, Herdr topology, and projection contracts.
- `src/herd/errors.ts` — schema-backed expected failures.
- `src/herd/protocol.ts` — Effect Schema decoding and Herdr wire translation.
- `src/herd/coordination.ts` — pure per-kind prompts/names, workspace selection, split selection, ownership matching, and persistence projection.
- `src/herd/workspace.ts` — managed workspace/tab validation, legacy-label migration, and non-focusing acquisition.
- `src/herd/reconcile.ts` — serialized remote/report reconciliation and retention.
- `src/herd/projection.ts` — pure sorting and footer summaries.
- `src/herd/service.ts` — sole run registry, serialized mutation owner, harness launch dispatch, persistent topology reconciliation, report ingestion, revision waiters, and monitor fiber.
- `src/tools/` — strict TypeBox contracts, bounded model-facing formatting, and seven cooperative-shell tools.
- `src/settings/controller.ts` — `/herdr` inspection, guidance, focus, and stop command.

## Ownership

### Parent Pi session ownership

One managed runtime starts from `session_start` and is disposed by `session_shutdown`, replacement, or tree navigation. Its finalizer stops only polling fibers and wakes Pi-side waiters. It never terminates a delegated process or closes a Herdr pane merely because parent Pi exits.

### Herdr ownership

The extension persists opaque session/workspace/tab/pane/terminal/name/**kind** tuples under the Pi agent directory. Kind is ownership-critical: a same-name process of another kind is not a match. Startup and state-changing Herdr operations are serialized across same-host Pi processes with a private atomic-directory lock, while `ProcessCoordinator` avoids redundant filesystem contention between runtimes in one process.

Run saves merge by opaque ID. Conflicting kind or model changes are refused; explicit `stopped` is monotonic; other terminal states outrank active snapshots before timestamp precedence. The extension revalidates the complete tuple before destructive pane closure and never adopts or closes resources from cwd, label, process kind, or name alone. A same-label foreign tab is not an ownership claim.

State version 2 adds required kind and optional model. Strictly decoded version-1 records migrate to `kind: "claude"` without changing opaque IDs or topology. A fully revalidated legacy `pi-herdr · Claude` tab is renamed under the topology lock to `pi-herdr · Agents`; changing the constant alone is never treated as ownership.

The managed tab is created lazily. Its root pane hosts the first agent; only additional agents receive split panes. The persisted anchor follows an extension-owned agent pane. Reconciliation automatically closes panes after durable `completed` or `failed` reports, while failures without a report remain available for inspection. Before closing the anchor, the service transfers it to another revalidated pane or creates the replacement shell Herdr requires to keep the tab alive. Automatic topology operations restore the previously focused user tab.

## Per-kind harnesses

Every start request requires a closed `claude | pi | codex` kind and a validated native model. Callers cannot provide executables, arbitrary argv, cwd, sessions, approval modes, or tool policies.

- **Claude** uses generated private settings containing only the marker-validated installed Herdr hook, an empty normal settings-source set, strict private MCP configuration, fixed allowed/denied tools, `dontAsk`, and a fixed appended policy.
- **Pi** runs with project trust disabled; normal extensions, skills, prompts, themes, and context discovery disabled; only the installed Herdr lifecycle integration plus `host-report-extension.ts` loaded; and only read/grep/find/ls/report tools active. Session files live inside the private run directory.
- **Codex** receives a per-run `CODEX_HOME`. It copies authentication into a private file but gets a generated strict config, an untrusted project entry, disabled web/apps/plugins/multi-agent surfaces, the native read-only sandbox, approvals `never`, exactly one report MCP server, and a generated hooks file containing only the marker-validated installed Herdr session hook. Codex's fixed hook-trust bypass is enabled solely for that isolated generated file. The target pane shell receives `CODEX_HOME` before Herdr starts the canonical Codex executable.

The state lock spans channel/harness preparation, pane acquisition or split, launch, prompt dispatch, persistence, and rollback. `maxActive` bounds persistent active or inspectable processes/panes per project. Transient pane readiness and kind-misdetection retries replace/clean provisional panes before retrying.

## Completion ownership

All kinds share one report document and reconciliation path. Claude and Codex connect to `report-helper.mjs` as a private stdio MCP server. Delegated Pi loads `host-report-extension.ts`; its sole tool calls the same helper through bounded JSON-RPC. The helper accepts exactly one bounded report, fsyncs and atomically renames `report.json`, and acknowledges only after durable storage. A later parent Pi session can ingest the receipt while the delegated process continues independently.

Terminal state is operational evidence only; a valid report is authoritative completion. A `blocked` report is final for that run: additional guidance is refused and the pane remains inspectable until explicitly stopped.

## Security

- Agent kind/executable and all policy argv are fixed; model is the only caller-selected native launch value beyond task/name.
- Claude receives read/web/report tools; Pi receives read/grep/find/ls/report; Codex receives its sandboxed shell plus report MCP with broad native features disabled.
- Project configuration is read only when trusted by parent Pi; delegated Pi/Codex project configuration is excluded.
- Herdr JSON, report JSON, persisted state, and child report input are bounded and schema/shape validated.
- CLI output is byte-bounded; report text is capped at 48,000 UTF-8 bytes.
- Harness config, session, MCP, and report files are private agent-directory state, never project artifacts.
- The report helper accepts no path, command, URL, executable, model, or environment from an agent.

Read-only is not a confidentiality boundary. Claude/Pi are capability policies rather than OS sandboxes; Codex adds its read-only sandbox, but MCP intentionally remains outside that sandbox. Filesystem reads plus model inference or network tools can exfiltrate data after prompt injection.

### Native restore exception

Herdr 0.7.5 restores official native sessions with bare commands (`claude --resume`, `pi --session`, `codex resume`) and does not replay pi-herdr's restricted argv, isolated harness, or report channel. The user explicitly chose to retain this behavior. Restored agents are outside pi-herdr's read-only/report guarantees. Changed terminal tuples fail ownership revalidation rather than being destructively adopted.

## Lifecycle limitations

Herdr 0.7.5/protocol 17 is the minimum supported automation surface. Kind-specific installed integrations are required but never installed or modified by pi-herdr. Cold Herdr restoration may replace terminals or resume unrestricted native sessions independently; missing or ambiguous resources are marked unknown. Persistent Herdr delegation belongs to this package; `pi-subagents` remains session-scoped and Pi-only.
