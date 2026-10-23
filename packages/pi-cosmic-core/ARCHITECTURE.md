# Cosmic Core architecture

Cosmic Core provides shared runtime, coordination, platform, and host-boundary contracts. It is a
library, not a Pi extension: it registers nothing of its own and owns no process-wide runtime;
host helpers such as the session wake register handlers only on the caller's extension API. The
only process-wide hook is the host-exit guard's `exit` listener, present while a guard is held.
Feature policy, provider schemas, and UI remain in consumer packages. The module map below describes the current
implementation; the ownership and lifecycle guarantees are what refactors must preserve.

## Ownership and dependencies

| Area                                                                               | Owns                                                                          | Consumer retains                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Runtime](src/runtime/)                                                            | Managed-runtime creation, session replacement, invocation authority, disposal | Application Layer, startup work, host activation               |
| [Coordination](src/coordination/) and [projection](src/projection.ts)              | Refresh admission, cancellation, atomic state/snapshot publication            | Eligibility, transition policy, renderer behavior              |
| [Platform](src/platform/)                                                          | Typed documents, HTTP, safe files, processes, and opt-in cross-process locks  | Domain validation, retry policy, resource-specific recovery    |
| [Configuration](src/config/)                                                       | Scoped document access, tolerant decoding, atomic settings commits            | Schemas, defaults, trust decisions, effective-value resolution |
| [Host commands](src/host-command.ts) and [capabilities](src/session-capability.ts) | Command routing and checked synchronous capability exchange                   | Command actions, protocol identity and admission policy        |
| [Session wake](src/host-wake.ts)                                                   | When notices start, continue, or wait for a turn                              | Notice content, reminders, extra settle work                   |
| [Agent messages](src/host-agent-messages.ts)                                       | Message frame, delivery through the wake, latest-reply reads, delivery text   | Sender labels, reply tools, notice types, refusals             |
| [Tool arguments](src/schema/tool-arguments.ts)                                     | Pi `prepareArguments` hooks: blank optionals, Pi-equivalent coercion, errors  | Parameter schemas, field aliases, tool-specific shape checks   |
| [Test kit](src/testing/)                                                           | Shared deterministic Layers, host fixtures, and scoped process/SDK harnesses  | Feature-specific fakes and behavioral assertions               |

Consumers import the public [root](index.ts), [testing](testing.ts),
[`testing/sdk`](src/testing/sdk-session.ts), or [`tool-arguments`](src/schema/tool-arguments.ts)
entrypoint. Core never imports extension packages. Shared helpers belong here when consumers need
the same contract, not merely similar code.

`tool-arguments` is separate because it imports TypeBox and `pi-ai` values, both optional peers
that only tool-owning consumers provide. Its preparer drops empty and whitespace-only optional
fields, except whitespace in fields the tool names as literal text, and drops an optional null only
where the field schema rejects null, as Pi does. It then runs Pi's own `validateToolArguments` so
the result is exactly what Pi then accepts, rejects blank required text, and turns failures into
bounded `[invalid_arguments]` errors that name paths, allowed values, and replacements for unknown
fields. A union's issues narrow to the branches selected by a property that every branch declares
as an enum or const. Empty arguments that fail are returned unchanged so Pi reports the malformed
tool-call JSON itself. The [tool-argument tests](tests/tool-arguments.test.ts) anchor this
behavior.

The SDK test entry is separate because it imports Pi SDK and `pi-ai` values; ordinary fixtures need
only the Pi coding-agent peer. The nominal keybindings fixture has a narrowly scoped type assertion
because Pi exposes no constructor. Review that bridge when upgrading Pi rather than spreading the
exception into consumers.

## Session and publication lifecycle

The host creates a managed runtime and supplies it to the
[session slot](src/runtime/session-runtime.ts). A new start immediately revokes old invocation
and publication authority, then serializes disposal and startup. Only the current generation can
activate its startup result. Commands invoked during startup keep their authority through activation;
replacement, shutdown, or runtime removal permanently revoke it. A failed startup effect logs only a
static class, `failure` or `defect`, through the runtime's logger before disposal; error tags and
messages are never logged. A Layer that fails to build has no logger, so its only signal is the
consumer's start-failure hook. Services and background fibers acquired inside the runtime close
with its scope.

Synchronous renderers consume detached snapshots. The [projection transaction](src/projection.ts)
keeps waiting, transition work, and snapshot preparation interruptible; external publication,
internal snapshot replacement, and authoritative state assignment form one narrow uninterruptible
commit. Failed preparation/publication leaves authoritative state and the internal snapshot unchanged.
Consumers guard the actual host publication against retired-session authority, including when an
already-admitted durable commit is allowed to finish.

Refresh coordination follows the same ownership principle: admission cannot be interrupted between
claiming work and installing cleanup, but work and joiners remain interruptible. Background polling
logs a cause-free warning and continues after a failed refresh; only interrupting it stops polling.
A revision bump or key change during a fetch discards its result; invalidation waits for an
in-progress commit. Each refresh runs under the caller's stable `spanName`.

## Session wake

[`registerSessionWake`](src/host-wake.ts) decides when an extension's notices reach the model. A
notice starts a turn only while the session is idle. While it is busy the notice is sent without a
turn, so Pi appends it at turn end outside the steering queue Esc clears, and the settling run
continues while such a notice (`hasUnansweredNotice`) follows the model's latest reply. A notice
appended after the last settle boundary, or during a compaction, gets one hidden wake message once
the session is idle. After an interrupt, and after `hold` at shutdown, notices only append until the
user's next non-extension input. With `holdDuringDialogs`, an open extension dialog also defers the
wake until it closes, and a run settling under an open dialog leaves its notice owed until then. Pi
chains `agent_before_settle` results across handlers, keeping the last
defined `entries` and `continue`, so each owner returns `undefined` when it has nothing to add and
keeps earlier handlers' entries otherwise; [two owners in one session](tests/host-wake-session.test.ts)
each get their notices continued.

[Bounded NDJSON framing](src/platform/bounded-ndjson-rpc.ts) for Effect RPC caps every frame,
complete or still buffered, in UTF-8 bytes and throws on oversized or malformed frames so the
transport closes the peer. `latestAssistantText` reads the latest assistant reply on a branch within
a byte limit, and `isSubagentChildProcess` reports the pi-subagents child marker so extensions can
stay out of child sessions.

## Persistence and resource safety

[JSON document writes](src/platform/json-document.ts) resolve the document's real path first:
symlinks are followed (a dangling link to its missing target), so a linked document stays a link and
its target is replaced. Each write and modification is serialized on that real path within the
process, then across same-host processes by a [document lock](src/platform/json-document-lock.ts):
a `CrossProcessLock` whose private root is a `.<name>.lock` directory beside the document. The root
stays after release, because removing it would race writers creating owner records inside it. Waiting is bounded (five seconds by default) and fails as a typed
`lock` document error; a crashed writer's lock is reclaimed by the next writer. Writing creates the
document's directory. Reads take no lock and rely on the atomic replacement. Feature stores validate
their schemas and combine durable writes with private state/projection installation where those must
agree. Default seeding rechecks existence inside the modification, and trust gates exclude untrusted
project paths before any read. Atomic file replacement prepares and validates before its rename commit.

Process and safe-file capabilities are explicit dependencies; file or network Layers do not silently
supply process execution. Platform support is limited to macOS and Linux. Scoped process cleanup
reports confirmed exit separately from a successful kill request. Process-tree sweeps wait for
observed process-group absence; inspection failures and deadlines remain uncertain. The
[host-exit guard](src/platform/process-group-exit-guard.ts) covers a detached group from
acquisition until its owner confirms settlement or closes the scope. The bounded process runner guards
each `detached` request until its sweep confirms the group gone or its scope closes. Each loaded copy of core keeps
one guard registry and installs a single synchronous `exit` listener only while a guard is held;
when the host exits without closing scopes, that listener sends `SIGKILL` to every guarded group.
It reaches only those groups, never processes that leave them, and nothing runs after host
`SIGKILL`. Owners release a guard as soon as the group settles so a reused ID is never killed. A failed
acquisition may leave cleanup uncertain, so callers must not infer resource release from an error
alone. Safe-file access validates containment, file identity, bounded reads,
and unchanged size/modification metadata across the read.

[Private files](src/platform/private-file.ts) are the shared no-follow mechanism for this user's
0700 directories and 0600 files: ensured directories must be real directories of this user and are
tightened to 0700, files are created exclusively and synced, replacement commits by an uninterruptible
rename with nothing fallible after it, and a failed write removes only the file it created. Failures
are a `PrivateFileError` with a bounded reason and no path or OS message. The cross-process lock
shares its ownership and mode checks but stays synchronous because its lease callbacks are.

[Cross-process locks](src/platform/cross-process-lock.ts) are an opt-in, same-host capability.
Exclusion requires the same private root and actual shared-resource namespace. `tryAcquire` does
not wait; callers own retries and the returned lease. `crossProcessLockHolder` names a slot and its
owner's process id for diagnostics without touching the lock. Recovery requires positive process-death
evidence and a quiescent journal. Owners record their process start time when the OS reports it,
read independently of the time zone and locale, so a live PID whose start time differs counts as
dead: a reused PID does not hold a lease forever. A recorded start in another format proves
nothing and leaves liveness unknown. `probeProcessLiveness` exports that check for consumers that
record owners of their own private state; on macOS it runs `ps` through the bounded process runner
so it never blocks the event loop. The synchronous `processLiveness` can block on `ps` for up to two
seconds and is reserved for synchronous ownership commits, such as lock recovery, where an
asynchronous gap would let another owner act between the check and the commit.
An uncancellable native mutation retains the lease until its real completion callback settles it; a
dead owner with pending native work fails closed.

Recovery barriers prevent a stale reclaimer from moving a successor. Successful normal release
cleans only its exact owner; recovery/crash/malformed artifacts can remain without a global storage
bound. There is no routine reset or online garbage collector. Offline recovery must stop participants,
inspect evidence, and independently establish native settlement before removing pending evidence.
Deleting coordination files cannot replace a caller's credential quarantine or recovery policy.

## Host integration and verification

Pi owns the terminal. Host logging must never write to stdout/stderr. A managed runtime may install a
file sink, flushed on scope closure; callers redact diagnostics before logging, and a broken sink
cannot fail startup. Standalone runners
use the quiet host logger. Session-start rotation does not bound high-volume feature logs during a
session, so those need their own retention policy.

The [workspace Effect guide](../../docs/architecture/effect-v4.md) and
[Pi boundary guide](../../docs/architecture/pi-boundaries.md) define shared contracts. Behavioral
anchors are the [session lifecycle](tests/session-runtime.test.ts),
[atomic projection](tests/projection.test.ts), [refresh ownership](tests/refresh-coordinator.test.ts),
[subscription refresh](tests/subscription-refresh.test.ts), [session wake](tests/host-wake.test.ts),
[document races](tests/json-document.test.ts),
[document files and processes](tests/json-document-files.test.ts),
[process cleanup](tests/process-runner.test.ts), [host-exit guard](tests/process-group-exit-guard.test.ts),
[safe-file](tests/safe-file.test.ts), [private-file](tests/private-file.test.ts), and
[cross-process recovery](tests/cross-process-lock.test.ts) tests. These protect observable guarantees;
module names and helper placement may change with ownership.
