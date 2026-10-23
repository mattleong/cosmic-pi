# Cosmic UI architecture

Cosmic UI owns the shared footer, working row, and Activity view, and supplies UI primitives to other extensions. Producers retain ownership of the work those views display. Public entrypoints are declared in [package.json](package.json); caller contracts live in [extension authors](docs/extension-authors.md) and [Activity](docs/activity.md).

## Session and host ownership

[application.ts](src/application.ts) connects Pi events to a replaceable session runtime; [layer.ts](src/layer.ts) composes configuration, footer projections, and Activity services. Core supplies runtime, persistence, refresh, and publication primitives. Host adapters contain Pi callbacks and process execution; renderers consume detached snapshots.

Replacement revokes the previous session's publication authority before resetting views. Host events are admitted only when their context carries the session manager captured at session start, and usage reconciles from that manager alone, so a replaced session's late events cannot redirect the replacement's context or totals. Old startup, probe, settings, or shutdown work cannot repaint or clear its replacement. A configuration write already committing may finish durably after retirement, but cannot publish into the new session. Shutdown releases subscriptions, surfaces, footer installation, and scoped tickers. [Extension tests](tests/extension.test.ts) and [service tests](tests/host-service.test.ts) exercise these races and recovery paths.

## Footer and configuration

Only TUI sessions fold usage history, activate the working row, or start repository/usage polling
and Activity clocks. Print, JSON, and RPC still resolve settings and publish preference readiness
with inactive footer ownership; producers retain their fallback UI and visibility policy. Their
Activity service has no host binding or clock. TUI startup and reconciliation share one incremental
usage reader rather than folding the same initial history twice.

[CosmicUiService](src/protocol/service.ts) owns resolved configuration, usage totals and their reconciliation, repository probes, and their frozen projection. [config/store.ts](src/config/store.ts) is the persistence boundary; resolution is read-only and explicit updates create documents. Git and pull-request invalidation exclude in-flight publication together, so an old branch result cannot reappear after invalidation. Pull-request polls back off while lookups find none; a forced lookup, including the one after each `bash` tool call, restores the base interval at once.

The [footer registry](src/footer/registry.ts) is synchronous presentation state: a protocol event that changes a contribution publishes a detached snapshot before requesting rendering. It bounds reentrant work and isolates callback failures. This keeps contribution changes observable inside the originating `pi.events.emit` without introducing asynchronous service coordination. [Footer installation](src/footer/installation.ts) owns mounting and render authority; only its current instance can request a render. See [registry tests](tests/registry.test.ts) and [installation tests](tests/footer-installation.test.ts).

The [footer protocol](src/protocol/protocol.ts) separates active ownership from preferences readiness. Producers wait for loaded preferences before automatic fetching, respect hidden contributions in both footer and fallback paths, and never install the footer themselves. [Settings](src/settings/controller.ts) use the shared command shell; failed updates restore authoritative values and stale settlements cannot overwrite newer choices.

## Activity

[ActivityService](src/activity/service.ts) owns provider registrations, accepted snapshots, retained summaries, and its scoped clock. The [protocol](src/activity/protocol.ts) binds capabilities to session, host activation, registration, and item revision. Invalid publication withdraws rows, starting counts, and replacement acknowledgement together; a valid publication can recover. Content, not revision, decides whether a republish changes anything: one matching the accepted snapshot publishes nothing, and only changed items are cleaned again, so publications reuse unchanged rows rather than copying them. Summaries and details are bounded, sanitized, and credential-redacted at their boundaries.

Producers own scheduling, retries, domain state, and action policy. Activity derives grouping and display from explicit parent relationships. [Retention](src/activity/model.ts) protects live work and its ancestors; source-removed history loses its actions. [Grouping](src/activity/grouped-tree.ts), [group summaries](src/activity/group-summary.ts), and [widget allocation](src/activity/widget-projection.ts) own the presentation algorithms rather than prescribing them here.

The [host](src/boundary/host-activity.ts) owns subscriptions, widget installation, and admission to one manager. Manager implementation and presentation state load only on opening; the host claims the opening before loading and rechecks its owner afterward. Failure or cancellation releases that claim, and retired loads never call the custom UI. Producers suppress fallback panels only after installation and accepted publication acknowledge replacement ownership. Detail requests are cancellable and checked for current authority; producers recheck their own authority after awaits before acting. These boundaries are covered by [service](tests/activity-service.test.ts), [host](tests/activity-host.test.ts), and [model](tests/activity-model.test.ts) tests.

## Shared presentation

[Owned surfaces](src/boundary/host-surface.ts) control one custom UI opening, admission, cancellation, and cleanup; callers retain domain lifecycle and action semantics. The [settings shell](src/boundary/host-settings-command.ts) shares command dispatch, persistence feedback, and invocation authority. Its registered-command owner orders saves across rows and invocation-local shells; reopening waits for admitted saves before capturing rows, without retaining a permit for the picker lifetime. Failed saves release ordering. Admission and dequeue reject retired work, and replacement activations bypass retired pending Promises. Closed pickers cannot publish late row updates; already admitted saves may finish privately. Consumers retain document conflict, revision, trust, and persistence ownership. See [surface tests](tests/host-surface.test.ts) and [settings command tests](tests/host-settings-command.test.ts).

[Manager components](src/manager/list-detail-shell.ts) may own local mutable selection, focus, filters, scroll, and keyboard state. Resource and domain ownership stays with services and host adapters. Rendering does not run Effects, fetch details, persist settings, or initiate work. Callers supply authorized data and actions; shared components provide navigation and presentation. [Tool presentation](src/tool/presentation.ts) supplies semantic rows, while Code Previews owns tool shells, highlighting, and scheduling.

The deliberate coupling to Pi's overlay closing, live viewport options, settings internals, and shared widget space is explained in [host integration](docs/host-integration.md).

## Working row and prompt identity

The [working row](src/working/row.ts) is a lifecycle-bound presentation adapter: synchronous Pi events update its local timing state, and an owned ticker writes the guarded working message. Deactivation stops the ticker and clears a running row. Prompt waits and unavailable UI pause displayed elapsed work without pausing provider measurement.

[Throughput](src/working/throughput.ts) measures main-agent calls; footer totals reconcile persisted session usage. These intentionally use different sources. [Host integration](docs/host-integration.md#usage-and-main-agent-throughput) explains cache warming and the limitation of prompt events without identity. [Working event tests](tests/working-events.test.ts) exercise the registered event path, and [working row tests](tests/working.test.ts) cover timing and cleanup.
