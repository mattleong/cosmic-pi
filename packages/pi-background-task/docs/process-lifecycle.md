# Process lifecycle

This note explains the process ownership behind the [architecture](../ARCHITECTURE.md).
The task service controls registry state; the local-process boundary supplies scoped handles
whose exit observation includes the platform's process-tree settlement policy.

## Acquisition, stop, and replacement

[The service](../src/task/service.ts) creates one child scope for all process monitors before
registering its shutdown finalizer. Shutdown closes admission and attempts to settle active
processes before that scope interrupts monitors. This ordering prevents monitor interruption from
abandoning process ownership and avoids accumulating session finalizers for historical tasks.

Cwd inspection remains interruptible before process acquisition. Acquisition itself is masked
on purpose: an interrupted monitor waits for Node to report the spawn or its failure, so a started
child always reaches its host-exit guard and group terminator, and scope release then terminates
it. After admission, a stop can race an unresolved spawn. Stop ownership is claimed with
interruption masked, then waiting resumes interruptibly. If that owner is interrupted, it
force-terminates an already-settled handle; the monitor is responsible for a handle that arrives
later. An interrupted monitor fails its waiting start instead of leaving the caller blocked.

A stop request and confirmed exit are different facts. Timeouts or termination failures leave
the record `stopping` and consuming active capacity. Only completion from the process monitor
settles it. A stop or runtime timeout that arrives after the leader already exited keeps the
command's own exit outcome. The first stop owns the grace window. A repeated explicit stop of a
`stopping` task, from the tool or `/tasks`, escalates to force; a runtime timeout, shutdown, or
tree navigation joins a running grace window instead and forces only a task whose window has
ended. `stopAll` stops every captured task concurrently, so shutdown and tree
navigation share one grace window, and it gathers failures after attempting every task rather than
letting one failure interrupt sibling cleanup. Shutdown logs a bounded warning for exits it cannot
confirm. The application revokes UI publication before this work, so late settlement cannot
restore rows from an abandoned runtime, and a failing publisher cannot abort a registry transition.

[Task-service tests](../tests/task-service.test.ts), [application tests](../tests/application.test.ts),
and [lifecycle stress tests](../tests/lifecycle-stress.test.ts) exercise pending acquisition,
interrupted stops, aggregate failures, and runtime replacement.

## Process-group termination

[The local-process boundary](../src/boundary/local-process.ts) dispatches graceful termination
immediately and owns escalation and release. Each task's shell leads its own process group on
macOS and Linux, and every signal targets that group. A graceful stop gives the entire group its
grace window even if the shell exits first; force escalation ends that wait and kills the group.
Ordinary leader exit instead triggers an immediate group sweep, preventing descendants with
inherited pipes from keeping the task open indefinitely. Once the group is observed gone or has
been swept after leader exit, it is never signalled again, because the system may reuse its ID.
The boundary spawns the shell with Node's child-process API rather than Effect's process
spawner, whose cleanup signals the group again after a nonzero exit, including at scope release.

The task's stdin is a pipe that nothing writes. Keeping it open matters because many watchers and
dev servers, such as `esbuild --watch`, exit cleanly once their input ends, which `/dev/null`
would do at once. The boundary closes the pipe when it dispatches any stop, when the group settles,
at scope release, and after a failed spawn, so no pipe outlives its task; errors on it are
ignored, so a task that closes its end can't fail the host. A command that reads input, such as a
prompt, waits until it is stopped or its timeout ends it.

Cleanup covers only the task's original process group. A process that starts its own session or
process group, such as a `setsid` child, a detached spawn, or a build daemon, is not tracked and
survives stop, shutdown, and host exit. If such a process keeps the task's pipes open, delivery
is abandoned one second after its group exits, and the task settles once its reader stops, within
another second. Output the reader has not received, output that arrives before the task settles,
and text the reader received but was still storing when it was stopped all count as dropped;
nothing after settlement is recorded.

From spawn until its group settles, the boundary registers the group with core's host-exit guard.
When Pi exits through `process.exit()` without session shutdown, as its uncaught-exception and
dead-terminal paths do, a synchronous `exit` listener sends `SIGKILL` to every registered group.
Nothing runs after host `SIGKILL` or machine loss, so those leave tasks running.

[Local-process tests](../tests/local-process.test.ts) cover group escalation, exit races, bounded
ingress, settled-group signalling after zero and nonzero exits through scope release, and real
descendant cleanup;
[process cleanup tests](../tests/process-cleanup.test.ts) cover abrupt host exit and batch grace
windows with real processes. Commands run with local-user authority; inherited environment values,
commands, paths, and output are not telemetry, and output is not persisted automatically.
