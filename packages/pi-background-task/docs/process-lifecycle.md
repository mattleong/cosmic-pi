# Process lifecycle

This note explains the process ownership behind the [architecture](../ARCHITECTURE.md).
The task service controls registry state; the local-process boundary supplies scoped handles
whose exit observation includes the platform's process-tree settlement policy.

## Acquisition, stop, and replacement

[The service](../src/task/service.ts) creates one child scope for all process monitors before
registering its shutdown finalizer. Shutdown closes admission and attempts to settle active
processes before that scope interrupts monitors. This ordering prevents monitor interruption from
abandoning process ownership and avoids accumulating session finalizers for historical tasks.

Cwd inspection remains interruptible before process acquisition. After admission, a stop can
race an unresolved spawn. Stop ownership is claimed with interruption masked, then waiting
resumes interruptibly. If that owner is interrupted, it force-terminates an already-settled
handle; the monitor is responsible for a handle that arrives later. An interrupted monitor whose
spawn never settled fails its waiting start instead of leaving the caller blocked.

A stop request and confirmed exit are different facts. Timeouts or termination failures leave
the record `stopping` and consuming active capacity. Only completion from the process monitor
settles it. `stopAll` gathers failures after attempting every captured task, rather than allowing
one failure to interrupt sibling cleanup. The application revokes UI publication before this
work, so late settlement cannot restore rows from an abandoned runtime.

[Task-service tests](../tests/task-service.test.ts), [application tests](../tests/application.test.ts),
and [lifecycle stress tests](../tests/lifecycle-stress.test.ts) exercise pending acquisition,
interrupted stops, aggregate failures, and runtime replacement.

## Platform termination

[The local-process boundary](../src/boundary/local-process.ts) dispatches graceful termination
immediately and owns escalation and release. On POSIX it signals the process group, with a leader
fallback, and sweeps descendants after leader exit. A graceful stop gives the entire group its
grace window even if the shell exits first; force escalation ends that wait and kills the group.
Ordinary leader exit instead triggers an immediate group sweep, preventing descendants with
inherited pipes from keeping the task open indefinitely.

On Windows, one process-scope fiber owns the graceful `taskkill` helper. Repeated graceful stops
reuse it; force escalation interrupts and joins it before serialized force attempts. A failed
attempt remains retryable. Core's bounded terminator requests helper cleanup without waiting for
a hung helper's exit, so interruption cannot block that join forever.

The boundary records leader exit and refuses its own later `taskkill`, because Windows may
reuse the PID. A helper racing natural exit treats an unsuccessful termination as settled once
the target exit is known. Release unrefs the upstream handle before the boundary's force attempt.
These guards apply to this boundary, not all behavior of the pinned Effect spawner.

The pinned spawner independently runs an untimed `taskkill /T /F` after nonzero leader exit and
again during finalization, even after unref. Failed or force-stopped Windows tasks therefore
retain a PID-reuse and shutdown-duration limitation outside this adapter's bound. Without Job
Objects, descendants that outlive the leader cannot be reliably cleaned up. Recheck this
dependency behavior when upgrading the process platform; do not describe the adapter's timeout
as a bound on all upstream finalization.

[Local-process tests](../tests/local-process.test.ts) cover helper escalation, exit races, bounded
ingress, and real descendant cleanup where supported. Cleanup cannot be guaranteed after host
`SIGKILL` or machine loss. Commands run with local-user authority; inherited environment values,
commands, paths, and output are not telemetry, and output is not persisted automatically.
