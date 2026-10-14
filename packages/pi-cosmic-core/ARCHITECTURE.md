# Cosmic Core architecture

Cosmic Core provides shared runtime, coordination, platform, and host-boundary contracts. It is a
library, not a Pi extension: it registers nothing and owns no process-wide runtime. Feature policy,
provider schemas, and UI remain in consumer packages. The module map below describes the current
implementation; the ownership and lifecycle guarantees are what refactors must preserve.

## Ownership and dependencies

| Area                                                                               | Owns                                                                          | Consumer retains                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Runtime](src/runtime/)                                                            | Managed-runtime creation, session replacement, invocation authority, disposal | Application Layer, startup work, host activation                      |
| [Coordination](src/coordination/) and [projection](src/projection.ts)              | Refresh admission, cancellation, atomic state/snapshot publication            | Eligibility, transition policy, renderer behavior                     |
| [Platform](src/platform/)                                                          | Typed documents, HTTP, safe files, processes, and opt-in cross-process locks  | Domain validation, retry policy, resource-specific recovery           |
| [Configuration](src/config/)                                                       | Scoped document access, tolerant decoding, atomic settings commits            | Schemas, defaults, trust decisions, effective-value resolution        |
| [Usage controller](src/usage-controller.ts)                                        | Refresh, eligibility, and configured state installation                       | Configuration persistence, provider fetching, and presentation policy |
| [Host commands](src/host-command.ts) and [capabilities](src/session-capability.ts) | Command routing and checked synchronous capability exchange                   | Command actions, protocol identity and admission policy               |
| [Test kit](src/testing/)                                                           | Shared deterministic Layers, host fixtures, and scoped process/SDK harnesses  | Feature-specific fakes and behavioral assertions                      |

Consumers import the public [root](index.ts), [testing](testing.ts), or
[`testing/sdk`](src/testing/sdk-session.ts) entrypoint. Core never imports extension packages.
Shared helpers belong here when consumers need the same contract, not merely similar code.

The SDK test entry is separate because it imports Pi SDK and `pi-ai` values; ordinary fixtures need
only the Pi coding-agent peer. The nominal keybindings fixture has a narrowly scoped type assertion
because Pi exposes no constructor. Review that bridge when upgrading Pi rather than spreading the
exception into consumers.

## Session and publication lifecycle

The host creates a managed runtime and supplies it to the
[session slot](src/runtime/session-runtime.ts). A new start immediately revokes old invocation
and publication authority, then serializes disposal and startup. Only the current generation can
activate its startup result. Commands invoked during startup keep their authority through activation;
replacement, shutdown, or runtime removal permanently revoke it. Services and background fibers
acquired inside the runtime close with its scope.

Synchronous renderers consume detached snapshots. The [projection transaction](src/projection.ts)
keeps waiting, transition work, and snapshot preparation interruptible; external publication,
internal snapshot replacement, and authoritative state assignment form one narrow uninterruptible
commit. Failed preparation/publication leaves authoritative state and the internal snapshot unchanged.
Consumers guard the actual host publication against retired-session authority, including when an
already-admitted durable commit is allowed to finish.

Refresh coordination follows the same ownership principle: admission cannot be interrupted between
claiming work and installing cleanup, but work and joiners remain interruptible. The usage controller
receives an initial resolved config and installs later `configure` updates through its refresh gate;
it does not own configuration persistence. Callers attach their scoped configuration observer before
explicitly starting polling, avoiding a missed update during construction. Lock order is configuration,
then document, then refresh; refresh commits never acquire configuration/document locks. Publication
authority is checked beside each actual host callback, so late refreshes cannot restore retired views.

## Persistence and resource safety

[JSON document modification](src/platform/json-document.ts) serializes each resolved path across
cooperating runtimes in one process. It is not cross-process exclusion. Feature stores validate their
schemas and combine durable writes with private state/projection installation where those must agree.
Default seeding rechecks existence inside the modification, and trust gates exclude untrusted project
paths before any read. Atomic file replacement prepares and validates before its rename commit.

Process and safe-file capabilities are explicit dependencies; file or network Layers do not silently
supply process execution. Platform support is limited to macOS and Linux. Scoped process cleanup
reports confirmed exit separately from a successful kill request. Process-tree sweeps wait for
observed process-group absence; inspection failures and deadlines remain uncertain. A failed
acquisition may leave cleanup uncertain, so callers must not infer resource release from an error
alone. Safe-file access validates containment, file identity, bounded reads,
and unchanged size/modification metadata across the read.

[Cross-process locks](src/platform/cross-process-lock.ts) are an opt-in, same-host capability.
Exclusion requires the same private root and actual shared-resource namespace. `tryAcquire` does
not wait; callers own retries and the returned lease. Recovery requires positive process-death
evidence and a quiescent journal. Owners record their process start time when the OS reports it,
so a live PID whose start time differs counts as dead: a reused PID does not hold a lease forever. An uncancellable native mutation retains the lease until its real
completion callback settles it; a dead owner with pending native work fails closed.

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
[usage publication](tests/usage-controller.test.ts), [document races](tests/json-document.test.ts),
[process cleanup](tests/process-runner.test.ts), [safe-file](tests/safe-file.test.ts), and
[cross-process recovery](tests/cross-process-lock.test.ts) tests. These protect observable guarantees;
module names and helper placement may change with ownership.
