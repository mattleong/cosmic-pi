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
- [Parent conversation](src/parent/application.ts) runs in the child too. A child launched with a
  parent reference gets a session runtime and the `parent_conversation` tool; every BTW child
  keeps a one-line orientation widget above the editor, which a later notice can't replace. The
  [reader](src/parent/reader.ts) opens the
  parent file without following a final link and reads at most its last 16 MiB; the pure
  [transcript](src/parent/transcript.ts) decodes each JSONL entry with Schema, skips what doesn't
  decode, and follows the newest entry's branch back to the session's start, a compaction, the
  requested message count (default 15, at most 50), or the read window. Results are bounded and
  render through the code-preview shell.

## Lifecycle

Session start inside Rex (`REX_SESSION` and `REX_BLOCK` set) creates the runtime; elsewhere no
runtime exists and `/btw` explains that it needs a Rex pane. Shutdown disposes the runtime and
forgets the newest pane; panes and their Pi processes stay with the user.

In a child, session start also loads trusted preview settings and starts the parent-conversation
runtime when the parent flags decode, then registers the tool and publishes its replay renderer,
anchored to `/btw`. Other sessions register no tool. Shutdown retires replay and disposes that
runtime.

## Critical invariants

- A split that may have run is never retried. Only Rex's `block target "…" not found` reply, which
  it sends before creating anything, lets the service forget the remembered pane and split the
  caller instead.
- Child arguments are passed positionally. The interactive-shell wrapper (`exec "$0" "$@"`) never
  reparses them, and a prompt beginning with `@` is kept from being read as a file attachment.
- The child loads this package with `-e` because Pi rejects unregistered flags; Pi skips the copy
  when settings also load it.
- The parent reference conveys a path only. The child reads the transcript through the read-only
  `parent_conversation` tool, or for older history its own read-only tools; nothing is imported,
  synchronized, or sent back to the parent.

[Launch tests](tests/launch.test.ts), [placement tests](tests/btw.test.ts),
[Rex client tests](tests/rex.test.ts), [parent-reference tests](tests/parent-reference.test.ts), and
[parent-conversation tests](tests/parent-conversation.test.ts) protect these boundaries.
