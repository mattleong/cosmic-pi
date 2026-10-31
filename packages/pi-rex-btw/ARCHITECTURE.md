# Architecture

`pi-rex-btw` opens a new blank Pi side session in a Rex pane for each `/btw`. It keeps no links,
saves no child sessions, and never closes panes.

## Ownership and boundaries

- [Extension](src/extension.ts) registers the command and the child's parent reference, and owns
  the per-session runtime slot. It captures the model, thinking level, and parent session when the
  command runs, and only notifies the session that issued the command.
- [BTW service](src/btw.ts) chooses the anchor pane and remembers, in memory only, the newest BTW
  pane so later panes stack beside it. Commands are serialized.
- [Rex client](src/rex.ts) owns the CLI transport: fixed argument arrays, an allowlisted
  environment, deadlines, output bounds, Schema decoding, and failure classification.
- [Launch policy](src/launch.ts) is pure: child arguments, split direction, input admission, and
  the parent-reference note.
- [Parent reference](src/parent-reference.ts) runs in the child. Before each run it rechecks the
  marker flags and the parent file and sets or clears its system-prompt section.

## Lifecycle

Session start inside Rex (`REX_SESSION` and `REX_BLOCK` set) creates the runtime; elsewhere no
runtime exists and `/btw` explains that it needs a Rex pane. Shutdown disposes the runtime and
forgets the newest pane; panes and their Pi processes stay with the user.

## Critical invariants

- A split that may have run is never retried. Only Rex's `block target "…" not found` reply, which
  it sends before creating anything, lets the service forget the remembered pane and split the
  caller instead.
- Child arguments are passed positionally. The interactive-shell wrapper (`exec "$0" "$@"`) never
  reparses them, and a prompt beginning with `@` is kept from being read as a file attachment.
- The child loads this package with `-e` because Pi rejects unregistered flags; Pi skips the copy
  when settings also load it.
- The parent reference conveys a path only. The child reads the transcript with its own read-only
  tools; nothing is imported, synchronized, or sent back to the parent.

[Launch tests](tests/launch.test.ts), [placement tests](tests/btw.test.ts),
[Rex client tests](tests/rex.test.ts), and [parent-reference tests](tests/parent-reference.test.ts)
protect these boundaries.
