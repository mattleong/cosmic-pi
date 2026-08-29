# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md).

## Workspace behavior

`/subagents settings` edits nesting policy in Session, Global, or trusted-Project scope. Direct children accept integers from 1 through 32 and depth accepts integers from 0 through 8. The controller rejects invalid input instead of clamping it. Session changes apply to later batches immediately. Persistent writes use `config/store.ts`, migrate valid version-4/5 documents to version 6, and require `/reload`. Lowering a policy never stops admitted runs.

`/subagents profiles` opens the Session profile dashboard. `/subagents profiles session` is equivalent. The dashboard shows the current scope and uses `1 Session`, `2 Project`, and `3 Global` to reopen a fresh immutable target while preserving the selected profile and pending-reload state. Project stays unavailable when the project is untrusted. If a persistent scope uses built-ins, inherits another scope, or has no valid editable default, the command opens Sets so the user can choose or create one.

`s` opens the secondary full-screen Sets workspace. Trusted projects show `[P]` and `[G]` sets together, plus `[P] Inherit global`; untrusted projects show only Global. The picker separates the active session-base selection from a saved selection waiting for reload. Enter edits a valid named set. `u` previews activation, and Enter confirms it. Delete uses the same Enter/Esc confirmation pattern. Create, same-scope copy, rename, search, and reload remain available. A project/global name collision remains two independent entries. Invalid defaults stay visible in redacted repair state, and structurally invalid sets cannot be activated or edited.

The profile dashboard opens the Profiles → Routing order → Primary/Fallback settings workspace against one immutable Session or `{scope, set}` target. Session routes are complete copy-on-write overlays, apply immediately to new launches, and write no files. Global and project edits use optimistic exact-document concurrency through `config/store.ts`, preserve unrelated sets and routes, and require `/reload`. Invalid intermediates never commit. Existing route options can be added, cloned, moved, removed, disabled, reset, or inherited without reordering another option. Destructive route changes use Enter to confirm and Esc to cancel.

The Sets workspace lives at `src/settings/profile-set-picker.ts`; the profile dashboard and route workspace live at `src/settings/profile-workspace.ts`. The interaction prototype is [`profile-ui-prototype.html`](profile-ui-prototype.html). `src/settings/ui/` contains only pure renderers, selectors, and picker projection. Disposal is idempotent. Components ignore later input/render/invalidation and discard late save, clear, reload, and catalog UI continuations. Already submitted persistence still settles. Disposal aborts catalog work and the registry refresh, then clears the controller's render callback.

## Model catalog

`src/settings/profile-model-catalog.ts` owns one replace-only immutable snapshot containing the root registry's projected authenticated Pi models. Registry refresh starts without delaying the overlay and accepts the overlay's abort signal. A successful non-aborted refresh projects the complete next generation and swaps it atomically. Failure, registry error, stale completion, or abort retains the prior snapshot. Each picker action captures one snapshot, so model fields never mix generations. Host/runtime actions derive the preferred Herdr Pi selector from the latest snapshot at that moment rather than from the snapshot that opened the workspace.

Local Pi offers `parent` plus authenticated canonical selectors. Herdr Pi offers the same canonical root-registry models except `parent`, which remains local-only. OpenCode Go can appear only as a provider in this Pi registry; it is not a subagent runtime or backend adapter. The root registry already reflects project trust, so extension-registered providers need no separate provenance gate. A configured selector that is no longer available remains an explicit current choice, so Enter cannot replace it silently. All provider, parent, and native catalog labels, descriptions, warnings, and search text pass through `sanitizeTerminalLine`; selector values remain unchanged.

Claude and Codex discovery stays cancelable and keeps current/default fallback choices when native discovery fails. Native selector grammar filters advertised entries. Codex fast-mode availability comes only from the captured live catalog's advertised `priority` tier; fallback selectors do not infer it. Pi fast mode uses the canonical static supported-model policy, while `parent` is resolved against the active model at action and launch time.

## Session handoff

The authoritative session route and nesting overlay survives `/tree`. During `/reload`, shutdown publishes only a frozen seed keyed by the current Pi session ID. The new instance first performs a shallow data-descriptor check of every known candidate-array length, without reading candidate elements, then schema-decodes the envelope and reapplies it to the newly loaded persistent base. Oversized or hostile envelopes are discarded. New, resume, fork, quit, and process restart clear the handoff.

## Module responsibilities

- `src/settings/controller.ts` owns root `/subagents`, `/subagents settings`, the dashboard-first profile loop, immutable scope handoffs, secondary Sets orchestration, fresh trust checks, and host lifecycle callbacks. `proxy-controller.ts` owns the packaged nested-Pi subtree command and keeps its visibility root fixed.
- `src/settings/profile-set-picker.ts` owns combined persistent-set editing, explicit activation, and lifecycle action input.
- `src/settings/profile-route-editor.ts` owns fixed-target route drafts and canonical validation messages.
- `src/settings/profile-model-catalog.ts` owns atomic Pi catalog refresh and runtime-specific picker loading.
- `src/settings/profile-workspace.ts` owns asynchronous fixed-target workspace state and disposal.
- `src/settings/ui/` owns pure set/workspace rendering, selectors, searchable pages, and sanitized model-choice projection.
