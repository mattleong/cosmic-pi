# Architecture

`pi-herdr-btw` manages one reusable blank side session per parent Pi session. `/herdr-btw`
focuses or resumes it; `/herdr-btw new` creates a replacement link after the new child starts.
The extension never closes user-owned panes.

## Ownership and boundaries

- [Application](src/application.ts) owns event wiring, the session-runtime slot, and
  generation-checked publication of the child's parent-reference capability.
- [Workflow service](src/btw/service.ts) serializes commands and coordinates creation, reuse,
  prompt delivery, and focus. [Command controller](src/btw/controller.ts) adapts TUI commands
  and reports bounded failures. [Layer composition](src/layer.ts) supplies the Herdr client,
  link store, and session-file capability; tests replace those Layers rather than the service.
- [Herdr client](src/boundary/herdr-client.ts) owns the CLI transport, fixed argument arrays,
  response decoding, deadlines, and mutation-outcome classification. Workflows and their tests
  use semantic client operations rather than the transport protocol.
- [Session-file boundary](src/boundary/session-file.ts) creates blank child files and verifies
  headers and filesystem identity without opening a mutable Pi session manager. Workflows use
  its `HerdrSessionFiles` service; synchronous host callbacks call the probes directly.
- [Link store](src/boundary/host-link-store.ts) owns persistence through parent custom entries.
  [Link policy](src/btw/link.ts) filters entries by owner; [validation](src/btw/validation.ts)
  establishes whether a live agent or session file is safe to reuse.
- [Parent-reference bridge](src/boundary/host-parent-reference.ts) adapts launch markers and
  the prompt hook. [Parent-link policy](src/parent-link/policy.ts) resolves candidates and
  formats the reference without reading transcript content.

## Lifecycle and commit points

Session start inside Herdr captures the parent identity and creates one runtime; sessions outside
Herdr create none, and commands there report that they need a Herdr pane. Commands revalidate that
identity before using it. Command notifications retain their originating session's authority.
Shutdown revokes that authority and the reference, and disposes workflow resources while leaving
panes and child sessions available to the user.

Creation prepares a private blank Pi session file, starts the child with `--session`, verifies
the reported pane, agent, and file identity, then records the link. It does not fork the parent
transcript. Before link commit, failures preserve the previous link. After commit, optional
prompt or focus failures leave the new link authoritative so the child is not orphaned.

Reuse validates the child file and checks live Herdr state before focusing an exact match or
starting a replacement pane. Ambiguous or conflicting agents are rejected. A second snapshot
before launch narrows duplicate-writer races; the child header and filesystem distinction are
revalidated after that snapshot, before dispatch. This is not a cross-process file lease and
cannot coordinate independently launched Pi processes.

## Critical invariants

- Native forks copy custom entries, so a link includes its parent owner. The store rechecks
  the live host and parent header before every restore or record, rejecting copied ancestor links.
- Parent and child must be distinct regular, non-symlink files. Descriptor identity catches
  hardlink aliases and preserves filesystem resolution through directory symlinks; an unavailable
  identity probe never counts as proof of distinction.
- An append that throws may already have persisted. The store distinguishes `refused` from
  `uncertain`; an uncertain mutation is not retried or followed by prompt/focus operations.
  Created panes remain available for inspection after failure.
- The parent-reference prompt section is revalidated for every child run and cleared on
  revocation or failed identity checks. It conveys a reference only: no transcript import,
  automatic synchronization, or return channel.

[Reuse tests](tests/btw-reuse.test.ts), [link-store tests](tests/link-store.test.ts),
[session-file tests](tests/session-file.test.ts), and [parent-reference tests](tests/parent-reference.test.ts)
protect these boundaries. The [README](README.md) describes the commands and operational limits.
