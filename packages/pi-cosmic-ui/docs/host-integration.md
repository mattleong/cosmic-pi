# Pi host integration

These are deliberate adaptations to the pinned Pi host, rather than general rules for UI code. Keep their behavior during refactors and review the host assumptions when upgrading Pi. [Architecture](../ARCHITECTURE.md) describes ownership; [extension authors](extension-authors.md) describes the public entrypoints.

## Closing an owned surface

Pi's custom-overlay `done` callback removes the topmost overlay, which may belong to a newer opening. [host-surface.ts](../src/boundary/host-surface.ts) first hides its own handle, places an inert non-capturing guard on top, calls `done`, and removes the guard. Failure never falls back to an unguarded pop. Inline surfaces can call `done` directly.

A finish requested before mounting waits for the handle. Cancellation revokes callback authority and disposes the dock immediately, then cleans up a late mount. The dock adapter forwards its component's optional disposal hook once, including cancellation before the input overlay mounts. For mounted surfaces, `onClose` runs before host completion and admission is released after completion and dock disposal. The [surface tests](../tests/host-surface.test.ts) cover stacked surfaces, interrupted mounting, and close failures using the shared [custom-host model](../src/testing/custom-surface.ts).

## Live options and shared widget space

Pi resolves its overlay-options callback at mount, then retains the returned object and reads its properties during rendering. [host-viewport.ts](../src/boundary/host-viewport.ts) therefore uses live getters. Pass that options object by identity: spreading or copying it freezes the dimensions and breaks resizing. [Surface tests](../tests/host-surface.test.ts) exercise a mounted view across terminal sizes.

All above-editor widgets share Pi's shrinking layout slot. A questionnaire dock can otherwise crowd out Activity. [host-input-dock.ts](../src/boundary/host-input-dock.ts) tracks visible dock presence in a process-wide slot, because extensions can load separate module copies; Activity uses that presence to compact its widget. Unique widget keys keep late cleanup from removing another presenter. See [dock tests](../tests/input-dock.test.ts).

## Settings bridge

[VimSettingsAdapter](../src/manager/settings-adapter.ts) deliberately accesses pi-tui's private `searchInput`, `setValue`, `applyFilter`, and `submenuComponent`. This keeps keyboard focus aligned with the child and clears a hidden search filter when leaving search without closing the settings surface. Keep this bridge narrow and inspect it directly on pi-tui upgrades. The bridge is not evidence that those internals are a public Pi contract.

## Pull-request footer links

The repository probe decodes `gh`'s PR number and actual URL together with Effect Schema, including enterprise hosts. Only HTTP(S) URLs without whitespace or control characters are admitted. Number and URL publish and invalidate together. Footer rendering adds Pi's OSC 8 hyperlink only after fitting and clipping plain text; clipped PR text remains unlinked, and the link closes before separators, padding, or following content. [Probe tests](../tests/probe.test.ts), [service tests](../tests/host-service.test.ts), and [footer tests](../tests/footer-primitives.test.ts) cover malformed output, terminal safety, invalidation, and narrow widths.

## Usage and main-agent throughput

[application.ts](../src/application.ts) derives footer totals from complete validated `sessionManager.getEntries()` snapshots, including persisted auxiliary usage such as cache warming. Malformed reads preserve the last complete same-session totals; a replacement resets them. Message-end events never add charges. The host has no public extension `entry_appended` event, so an idle ticker also reconciles persisted usage. It neither republishes nor renders unchanged totals. [Extension tests](../tests/extension.test.ts) cover idle warming, duplicate events, failed reads, and replacement.

Throughput starts at `context_with_system` and ends at assistant `message_end`. Provider hooks also run for cache warming, so using them would misattribute auxiliary calls to the main agent. Completed samples use validated final output and include initial latency and stream stalls; unfinished or invalid samples contribute neither tokens nor duration. Prompt waits affect the displayed work timer, not this measurement. See [working event tests](../tests/working-events.test.ts).

## Prompt identity limit

Pi prompt events carry neither prompt nor session identity. [The working row](../src/working/row.ts) admits prompts only during an active run and resets prompt state on settlement or deactivation. It cannot distinguish a stale prompt start first delivered after replacement from a new session's prompt while that session is running. A stronger guarantee requires host-provided identity; adding local generations alone cannot recover it.
