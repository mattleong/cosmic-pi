# The native write boundary

Write is Code Previews' only execution hook because a reliable diff needs evidence from immediately
before the actual mutation. Renderer lookup alone cannot establish that evidence. The hook preserves
Pi's direct-write semantics, including symlink, hard-link, inode, and open-descriptor behavior; replacing
a file atomically here would change the native tool's contract.

[Native Pi write](../src/boundary/host-write.ts) owns path resolution, its cross-tool mutation queue,
and the abort checks around operation callbacks. There is no outer Code Previews path lock. The
invocation captures the originating session capability, and its runtime owns the interruptible queue
wait. Cancelling or replacing that session aborts admission without waiting for a held predecessor;
Pi checks the signal before invoking delayed operations.

Pi's operation callbacks return Promises. The boundary runs their Effects in the invocation's scope
and returns Promises that join those workers without an abort signal. This detail keeps Pi's queue
held until already-admitted masked work actually settles. Otherwise interruption could release the
native queue while a filesystem mutation was still running.

[Preview execution](../src/write/preview-execution.ts) keeps the before-read interruptible after queue
admission. It then checks abort before a narrowly masked direct write and matching correlation commit.
Directory creation is masked separately. An applied write publishes its before-write evidence before
interruption becomes observable. The [write service](../src/write/service.ts) publishes bounded,
immutable correlation snapshots, and renderer lookup is non-destructive so repeated rendering does
not consume evidence.

[Behavioral tests](../tests/write/preview-execution.test.ts) cover cancellation while queued, during
the before-read, and during mutation, including a second writer that must wait for correlation
settlement. Revisit these tests and the pinned Pi queue implementation together when upgrading Pi.
