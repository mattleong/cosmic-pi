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

## Process-group termination

[The local-process boundary](../src/boundary/local-process.ts) dispatches graceful termination
immediately and owns escalation and release. On macOS and Linux it signals the process group,
with a leader fallback, and sweeps descendants after leader exit. A graceful stop gives the entire
group its grace window even if the shell exits first; force escalation ends that wait and kills the group.
Ordinary leader exit instead triggers an immediate group sweep, preventing descendants with
inherited pipes from keeping the task open indefinitely.

[Local-process tests](../tests/local-process.test.ts) cover group escalation, exit races, bounded
ingress, and real descendant cleanup. Cleanup cannot be guaranteed after host `SIGKILL` or machine
loss. Commands run with local-user authority; inherited environment values, commands, paths,
and output are not telemetry, and output is not persisted automatically.
