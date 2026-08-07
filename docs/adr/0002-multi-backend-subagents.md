# ADR 0002: Multi-backend subagents Phase One contract

- Status: Accepted
- Date: 2026-07-30

## Context

Before the unified implementation, `pi-subagents` owned session-scoped Pi children while a separate extension owned persistent read-only Claude, Pi, and Codex panes. The Phase One multi-backend MVP presents one profile-routed subagent product without preserving both lifetime models or exposing backend mechanics at every launch.

This ADR freezes the product contract and the technical interpretations needed before configuration version 4 and the backend refactor begin. Phase A implements only recursion guards, orchestration-tool exclusion, and fail-closed writer cleanup. It does not implement configuration version 4 or merge the backend services.

## Decision

### One session-owned fleet

Every run started through the unified product is owned by the current parent Pi session, whether its host is local or Herdr. Session shutdown, replacement, tree navigation, or reload ends the unified run and performs the host-appropriate stop/close operation. A Herdr process started by this product does not inherit the retired standalone extension's persistence across parent sessions.

Session ownership is a product lifetime, not necessarily an in-process lifetime. A Herdr server still owns its PTY and process while a run is active, but the parent session owns the obligation and authority to close the resources it launched.

### Profile-only nonblocking launch

The start tool is nonblocking and accepts one bounded `agents` array. Each element selects a profile and supplies a self-contained task, with an optional display name. It does not accept a host, runtime, model, execution mode, lifetime, policy, or arbitrary command line. A start call resolves and launches the batch, reports per-item admission failures, and returns the admitted run identities without waiting for reports.

There is no foreground start mode. Waiting is a separate operation. Routing decisions come only from the selected profile, including its ordered candidate fallback.

### Configuration version 4 candidate

A version-4 profile route is an ordered list of candidates. A candidate's product fields are:

- `host` — `local` or `herdr`;
- `runtime` — `pi`, `claude`, or `codex`;
- `model` — the native model selector for that runtime;
- `effort` — the normalized runtime effort/reasoning selection;
- `context` — the supported context mode;
- `writeIntent` — `writer` or `read-only`;
- `closeOnReport` — whether the host resource closes after a report.

Version 4 will not add `execution`, `lifetime`, or generic policy lists. It will not expose free-form allowed/denied tool lists, approval lists, executable paths, argv, environment, sessions, hooks, or sandbox configuration. Those are fixed adapter policy and capability checks, not user routing data.

The six required host/runtime combinations are:

| Host  | Runtime     |
| ----- | ----------- |
| local | Pi          |
| local | Claude Code |
| local | Codex       |
| Herdr | Pi          |
| Herdr | Claude Code |
| Herdr | Codex       |

Each combination must either satisfy the candidate's context, effort, write intent, and reporting requirements or be skipped with a typed reason. Candidate fallback never weakens a hard requirement.

`closeOnReport: false` is valid only for a Herdr-hosted read-only candidate. All local candidates and every writer close on report. A false value keeps the session-owned Herdr run available for additional report generations and guidance; it does not make the run survive the parent session.

### Context and Herdr session interpretation

Native fork is supported only by local Pi. It means a private copy of the stable parent Pi branch and never degrades silently to fresh context. Claude, Codex, and every Herdr-hosted runtime must reject or skip a fork candidate.

Herdr routing uses only the Herdr session inherited by Pi, otherwise Herdr's default session. Configuration, profile candidates, and launch requests cannot name, discover, or attach to another Herdr session. Herdr workspace, tab, pane, and terminal identifiers remain adapter-owned opaque ownership evidence.

### Reports and generations

A report is a bounded, schema-decoded generation belonging to one run. It is not a project file and is not an unbounded transcript.

The initial report generation is await-claimable: an await operation can claim and return it exactly once under the same cancellation-safe claim semantics used for local completion. For `closeOnReport: false`, later report generations remain associated with the same run and are published only when the user or parent explicitly asks the retained agent to report back. A later generation that is not claimed by an active consumer is automatically pushed to the parent through bounded, generation-aware delivery; an idle parent is awakened, while an active parent receives steering context. Claim, acknowledgement, cancellation release, deduplication, and retry must prevent both loss and duplicate model delivery.

No report artifacts are written into the project. Harness configuration, receipts, report documents, and session copies live only in private agent-directory state with restrictive permissions and bounded retention.

### Communication transports

The unified service defines capabilities and outcomes; it does not pretend all six combinations share one transport.

- Every supported host/runtime combination exposes the same bounded supervisor events: progress, warning, one correlated blocking parent question, and report generations. Progress remains projection-only; warnings, questions, and unclaimed reports enter parent context through generation-aware delivery.
- Local Pi continues to use Pi's existing RPC process transport for commands and events and its existing bounded child-to-parent contact channel. A local Pi report is the assistant final response/tool event already emitted over that RPC stream. It is not a new custom report RPC method or a project report file.
- Local Claude uses its native stream-JSON control surface plus a private adapter-owned MCP communication and report service. Local Codex uses its supported JSON event surface plus the private MCP service; general guidance may wait for a safe turn boundary, but a correlated MCP question remains blocked until its exact reply arrives.
- Herdr-hosted runs are controlled through the bounded Herdr client and observed through PTY/topology evidence plus the private communication/report service. Delegated Pi loads a fixed bridge extension; Claude and Codex use fixed MCP tools. Parent Pi cannot assume ownership of the delegated process's stdin/stdout.
- The MCP service must support bounded concurrent request dispatch, cancellation, correlated replies, and serialized output; a blocking question must not prevent ping, cancellation, or unrelated responses.
- Interruption, resume, rename, and live reads are advertised only where the selected host/runtime can implement them with a confirmable outcome. Unsupported operations fail with typed capability errors.
- Every command, event, report, and diagnostic crossing a process boundary is bounded and decoded. Ambiguous sends are reported as outcome-uncertain and are not retried automatically.

### Writer coordination target

The safety invariant is one writer for the same working directory across same-host parent processes, regardless of local or Herdr host and regardless of runtime. Achieving that cross-process invariant is an eventual MVP target, not a claim made by the Phase A in-memory guard. The implementation must use an ownership-token-checked same-host lock with liveness/orphan handling before advertising cross-process writer safety.

The current Phase One tree implements that target for declared writers in `pi-subagents` with a parent-owned private agent-directory protocol keyed by a SHA-256 digest of stable local directory identity (device + inode/file ID), not pathname. `realpath` remains launch/diagnostic data, so symlink aliases and directory renames cannot evade the in-memory or disk guard. Windows writer starts are rejected with typed `unsupported_safe_writer_ownership` before lease or spawn until native Job Object ownership can prove descendant termination; read-only starts remain allowed. Read-only Pi now exposes unsandboxed Bash for inspection and validation without taking this lease, so its no-mutation rule is behavioral and a violating shell command is outside the one-declared-writer guarantee.

A lease begins as `reserved`. An ownership-token-checked, atomic, synced `markSpawnStarted` transition must confirm before every initial or respawn backend driver call. If that transition fails or is ambiguous, no spawn is invoked. Positive parent death permits reclaim only for stably decoded `reserved` evidence. Parent death is insufficient for `spawn-started`: detached local process groups and Herdr PTYs can survive, so spawn-started, corrupt, transitional, permission-denied, or otherwise uncertain evidence remains fail-closed. Recovery is manual private-state removal only after an operator independently verifies external backend and descendant death; this ADR makes no automatic crash-cleanup claim for those leases.

Dead-reservation takeover and normal release atomically move the whole token-bound lease to the same deterministic non-empty destination derived only from the old token, then verify moved evidence. That common enduring destination prevents duplicate/delayed takeover and release operations from moving a replacement lease across either kind of ABA cycle. Tombstones stay in private agent state, carry only bounded evidence, and grow linearly with ownership history; they are not automatically garbage-collected because the protocol cannot prove that an old delayed operation is gone. Backend or lease cleanup uncertainty retains both disk ownership and session quarantine.

## Read-only capability limitations

`read-only` is a capability policy, not a confidentiality or general security boundary.

- Pi read-only mode uses a fixed tool allow/deny policy that now includes Bash for inspection and validation while excluding direct edit/write tools. Pi has no OS filesystem sandbox; Bash can technically mutate files, so the no-mutation contract is behavioral rather than enforced.
- Claude and Codex expose shell execution inside their mandatory native read-only sandboxes. Claude fails closed when its strict Bash sandbox is unavailable and explicitly denies Bash writes to the assigned cwd for read-only runs. Adapter-owned MCP servers, lifecycle hooks, model/web traffic, and other host capabilities remain outside those subprocess sandboxes by design.
- Allowed file reads, web tools, model inference, and runtime network behavior can disclose sensitive content after prompt injection. Read-only does not mean confidential or offline.
- Capability policy does not roll back side effects performed by allowed external services, host hooks, or pre-existing processes. It cannot prove that a native session restored by another product retains the launch policy.
- Herdr native restore may resume an official session without replaying the restricted launch arguments. Such a restored process is outside the unified run's guarantees and must fail ownership revalidation rather than be adopted.
- Unknown extension tools are excluded rather than assumed safe. The policy intentionally sacrifices capability for fail-closed behavior, but exclusion alone is not proof of non-mutation.

The product documentation and tool output must describe these limits accurately: Pi execution is not sandboxed, while Claude/Codex sandbox claims apply only to their model subprocess shell boundary.

## Consequences

- Configuration version 4 and backend composition can be designed against one frozen launch and lifetime contract.
- The retired standalone extension's persistence behavior is not the behavior of a Herdr backend inside unified `pi-subagents`.
- Nonblocking batch start and separate await remove execution/lifetime branching from launch schemas.
- Adapters remain materially different behind one capability-aware service; transport-specific guarantees are not flattened into unsafe common promises.
- Phase A can improve recursion and writer cleanup safety without introducing a package dependency cycle or prematurely implementing the backend refactor.
