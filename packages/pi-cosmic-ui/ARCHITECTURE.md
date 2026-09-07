# Cosmic UI architecture

Cosmic UI hosts the composable Pi footer, repository probes, working timer, activity tree, settings, and plain-data contribution protocols.

## Session and host ownership

`src/extension.ts` is the entrypoint. `src/application.ts` owns registration, protocol subscriptions, and session orchestration. `src/layer.ts` composes config, footer registry, protocol host, working timer, activity, and host-callback services. It injects plain process and working-message contracts into their consumers rather than adding adapter services.

Startup passes the working-timer service and runtime token through the session slot. Timer and prompt transitions check the token and agent generation both at admission and execution; output ingress checks before accumulation. Duplicate starts are idempotent. A separate host lifecycle generation guards delayed shutdown and failed-start continuations so old cleanup cannot clear replacement context, totals, ingress, or projections.

`src/boundary/` contains Pi I/O and hostile host-callback handling. Footer getters are materialized through `HostCallbackBoundary`; usage numbers are Schema-decoded before arithmetic. Settings, usage, and protocols share the private `src/schema/decode.ts` decoder. Protocol normalization retains an outer guard for hostile proxies. `host-exec.ts` is the sole Git/`gh` boundary; probe policy remains in `src/probe/` and checks Git currentness after each process yield.

`host-status.ts` supports sanitized TUI/RPC status while keeping custom-footer declarations TUI-only. It republishes placement on host replacement. `host-ui-ticker-pool.ts` owns one scoped fiber per cadence, isolates failing callbacks, and interrupts a cadence on final unsubscribe. Shutdown rotates the cross-extension status owner and awaits the old pool before reuse.

## Footer and configuration

`CosmicUiService` in `src/protocol/service.ts` publishes frozen config, totals, Git, and pull-request projections. `FooterRegistryService` owns contribution lifetimes and optional surface resources in each registry entry. Upsert attaches the replacement before publication, closes the old resource, then requests rendering. Each entry owns a detached frozen contribution. Normalized values retain identity; raw values are copied once, preserving surface callback receivers. Only changed registry-state identity replaces the snapshot. Lifecycle-only invalidation still invokes callbacks.

`src/footer/installation.ts` owns synchronous installation generations and disposal. Footer components read detached projections without running Effect. Layout sanitizes text/status, resolves semantic tones to Pi theme tokens, and preserves only anchored Kitty/iTerm image lines and safe visual SGR on ordinary lines.

`src/protocol/protocol.ts` defines the public v2 footer protocol; `canonicalization.ts` owns copying, freezing, and identity reuse. Discovery reports live footer ownership, settings readiness, and hidden IDs. Providers wait for preferences before automatic fetching, honor hidden IDs in contribution and fallback paths, and never install a footer themselves. `src/protocol/host.ts` owns scoped ingress. Its bounded pre-session drain reserves batch capacity across yields and restores failed events plus their untouched suffix ahead of newer arrivals; activation flushes the final race window synchronously.

`src/config/store.ts` is the only persistence entrypoint, using core's scoped config store without a default document. Resolution never writes; explicit updates create documents. `schema.ts` owns defaults, leaf schemas, and fresh fallback values; the store decodes fields tolerantly. `src/settings/controller.ts` registers `/cosmic-ui` and uses shared per-row settlement generations. Current settlements reread authoritative config, failures roll back, and stale settlements cannot overwrite newer optimistic values. Currentness checks remain around reentrant host callbacks.

## Activity

`src/activity/service.ts` owns the session provider registry, registration generations, retained summaries, and scoped clock. Core's frozen projection transaction allows interruptible validation and lock waiting, followed by atomic publication. Invalid snapshots withdraw rows, starting counts, and acknowledgement together. Valid publication can restore them. Active launch-request counts take precedence over overlapping pending agent counts; counts drive startup visibility and the 100 ms clock even without rows.

The v1 client in `src/activity/protocol.ts` carries exact session ID, host activation nonce, and producer registration token. Same-session replacement rejects replay, and revoked registrations cannot return. Summaries are bounded, detached, sanitized, and credential-redacted before broadcast and again at ingress. Callbacks are checked capabilities, not services or runtimes. Providers hide legacy panels only after successful widget installation and an accepted snapshot acknowledge ownership. Disposal, invalid publication, and teardown restore fallback availability.

`src/activity/model.ts` resolves explicit ownership over an existing row map for both retention and `tree.ts`. Missing direct parents become roots; every path entering a cycle becomes an independent root. Retention caps removable completed rows at 128 per branch and 1,024 per session, plus 100 finished root branches. Live/awaited rows and their resolved ancestors are protected. Omission counts are lower bounds and do not grow from repeated snapshots. `/activity` exposes history; the eight-row widget hides finished branches while preserving completed ancestors of live or awaited descendants. Selection, collapse, and focus preferences remain session-owned.

`component.ts` uses shared manager components and preserves displayed action revisions. Destructive producer actions require separate confirmation. `attention.ts` classifies human input, parent waits, and blocked states; protocol validation requires explicit attention metadata. Details load only on explicit open/refresh, remain marked stale across updates, and are bounded/redacted by the service. Capability checks surround fetching, and callbacks receive Effect cancellation signals. Producers must also recheck their own session, revision, and action policy.

`src/boundary/host-activity.ts` owns scoped subscriptions, synchronous projections, widget acknowledgement, and single-owner manager admission. Its pinned Pi onHandle/owned-guard overlay pattern handles late mounts, interruption, cleanup failure, and newer overlays. Each opening owns close and detail-cancellation capabilities. The manager closes before producer actions and does not render questionnaires. Only this named host boundary submits activity Effects to the session runtime.

## Shared presentation

`src/manager/` contains Effect-free chrome, key resolution/labels, list navigation, list/detail composition, selectors, and settings adapters. `ListDetailShell` owns generic selection, pane/layout, scroll, page sizes, and keymap chord state. Actions, confirmation policy, follow policy, domain predicates, and content stay caller-owned. Shared frame helpers bound output, preserve empty sizes and top-only single rows, and frame caller-supplied bodies. Searchable selectors retain selection identity through filtering and use those helpers; model pickers only project already-authorized catalogs. Acquisition, validation, persistence, and lifecycle remain with callers.

`settings-surface.ts` composes caller headers, Pi `SettingsList`, `VimSettingsAdapter`, and the focus/render bridge; it also owns reusable row generations and submenu composition. Host guards remain injected and caller-owned. `settings-adapter.ts` deliberately couples to pinned pi-tui private `searchInput`, its `setValue`, `applyFilter`, and `submenuComponent`. Esc leaving search clears and reapplies the filter without closing the child. Review this bridge directly on pi-tui upgrades.

`src/tool/presentation.ts` renders semantic tool headers and bounded plain sections. It does not own code-preview shells, highlighting, caching, or scheduling. The package root exports only the extension; named subpaths expose shared protocols and presentation components.

## Working timer and prompt identity

`src/working/service.ts` owns the scoped ticker and output-rate estimate. One `SynchronizedRef` serializes elapsed time, output time, and prompt waiting. `owner.ts` tracks runtime/agent/prompt ownership under application events. The outer prompt freezes both clocks and drops output deltas; prompt end restores prior elapsed time. Transient host-write failures are retried without advancing clocks during a prompt. Duplicate prompt events do nothing.

An accepted prompt start retains the active run's owner object and runtime token. Prompt release returns a captured resume callback, which application invokes after updating context. Admission checks the token; execution rechecks activation and run identity. Delayed stops also check the settled generation. Agent settlement, deactivation, and shutdown clear ownership. Pi prompt events have neither prompt nor session identity. A stale start first arriving after replacement while the new agent is active is indistinguishable from a current prompt and is attributed to the replacement runtime.

## Lifecycle

```text
protocol events -> bounded buffer -> scoped host -> registry snapshot
session_start -> application -> layer -> services -> footer installation
agent_start + streaming deltas -> working timer/rate -> Pi working message -> agent_end reset
ui_prompt_start -> freeze timer/rate -> ui_prompt_end -> resume elapsed
Pi changes -> service refresh -> frozen projection -> render request
session_shutdown -> subscriptions/footer/runtime disposed -> ticker pool rotated and awaited
```
