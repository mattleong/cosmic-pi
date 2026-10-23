# Pi host integration

These are deliberate adaptations to the pinned Pi host, rather than general rules for UI code. Keep their behavior during refactors and review the host assumptions when upgrading Pi. [Architecture](../ARCHITECTURE.md) describes ownership; [extension authors](extension-authors.md) describes the public entrypoints.

## Closing an owned surface

Pi's custom-overlay `done` callback removes only its own overlay, and inline openings share Pi's extension-dialog stack. [host-surface.ts](../src/boundary/host-surface.ts) hides its own handle, which also disposes a dock, then calls `done`. A failed hide or disposal is reported as a failure, but `done` still runs: an unsettled `custom()` call keeps Pi's UI prompt open, so `ui_prompt_end` never fires and prompt-gated work such as questionnaires, wake holds, and the working row stays paused.

A finish requested before mounting waits for the handle, because Pi disposes an overlay component only when `done` follows its mount. Cancellation revokes callback authority and disposes the dock immediately, then cleans up a late mount. The dock adapter forwards its component's optional disposal hook once, including cancellation before the input overlay mounts. For mounted surfaces, `onClose` runs before host completion and admission is released after completion and dock disposal. The [surface tests](../tests/host-surface.test.ts) cover stacked surfaces, interrupted mounting, and close failures using the shared [custom-host model](../src/testing/custom-surface.ts) of Pi's own-entry closing and inline dialog stack.

## Live options and shared widget space

Pi resolves its overlay-options callback at mount, then retains the returned object and reads its properties during rendering. [host-viewport.ts](../src/boundary/host-viewport.ts) therefore uses live getters. Pass that options object by identity: spreading or copying it freezes the dimensions and breaks resizing. [Surface tests](../tests/host-surface.test.ts) exercise a mounted view across terminal sizes.

All above-editor widgets share Pi's shrinking layout slot. A questionnaire dock can otherwise crowd out Activity. [host-input-dock.ts](../src/boundary/host-input-dock.ts) tracks visible dock presence in a process-wide slot, because extensions can load separate module copies; Activity uses that presence to compact its widget. Unique widget keys keep late cleanup from removing another presenter. See [dock tests](../tests/input-dock.test.ts).

## Settings bridge

[VimSettingsAdapter](../src/manager/settings-adapter.ts) deliberately accesses pi-tui's private `searchInput`, `setValue`, `applyFilter`, and `submenuComponent`. This keeps keyboard focus aligned with the child and clears a hidden search filter when leaving search without closing the settings surface. Keep this bridge narrow and inspect it directly on pi-tui upgrades. The bridge is not evidence that those internals are a public Pi contract.

## Pull-request footer links

The repository probe decodes `gh`'s PR number and actual URL together with Effect Schema, including enterprise hosts. Only HTTP(S) URLs without whitespace or control characters are admitted. Number and URL publish and invalidate together. Footer rendering adds an OSC 8 hyperlink only when pi-tui reports hyperlink support, which also honors `PI_HYPERLINKS`, and only after fitting and clipping plain text; clipped PR text remains unlinked, and the link closes before separators, padding, or following content. [Probe tests](../tests/probe.test.ts), [service tests](../tests/host-service.test.ts), and [footer tests](../tests/footer-primitives.test.ts) cover malformed output, terminal safety, invalidation, and narrow widths.

## Usage and main-agent throughput

[CosmicUiService](../src/protocol/service.ts) derives footer totals from complete validated `sessionManager.getEntries()` snapshots, including persisted auxiliary usage such as cache warming. Because Pi sessions are append-only, each read folds only entries appended since the last complete read; a shorter session, or one whose last folded entry moved, is folded again from its start. Malformed reads preserve the last complete same-session totals; a replacement resets them. Reconciliation reads the session manager captured at session start, never the latest event context. A reconciliation interrupted after publishing new totals leaves them unnotified, and the next reconciliation repeats the skipped invalidation and render. Message-end events never add charges. The host has no public extension `entry_appended` event, so a scoped one-second loop in the session runtime also reconciles persisted usage. It neither republishes nor renders unchanged totals. [Extension tests](../tests/extension.test.ts) cover duplicate events, failed reads, and replacement; [service tests](../tests/host-service.test.ts) cover idle reconciliation on the Effect clock.

Throughput starts at `context_with_system` and ends at assistant `message_end`. Provider hooks also run for cache warming, so using them would misattribute auxiliary calls to the main agent. Completed samples use validated final output and include initial latency and stream stalls; unfinished or invalid samples contribute neither tokens nor duration. Prompt waits affect the displayed work timer, not this measurement. See [working event tests](../tests/working-events.test.ts).

## Prompt identity limit

Pi prompt events carry neither prompt nor session identity. [The working row](../src/working/row.ts) admits prompts only during an active run and resets prompt state on settlement or deactivation. It cannot distinguish a stale prompt start first delivered after replacement from a new session's prompt while that session is running. A stronger guarantee requires host-provided identity; adding local generations alone cannot recover it.
