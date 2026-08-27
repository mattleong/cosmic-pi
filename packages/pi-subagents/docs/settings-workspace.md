# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md).

## Workspace behavior

`/subagents settings` edits version-5 nesting policy in Session, Global, or trusted-Project scope. Direct children accept integers from 1 through 32 and depth accepts integers from 0 through 8. The controller rejects invalid input instead of clamping it. Session changes apply to later batches immediately. Persistent writes use `config/store.ts`, upgrade version 4 to version 5, and require `/reload`. Lowering a policy never stops admitted runs.

`/subagents profiles` opens a full-screen Profiles → Route → Candidate editor for Session, Global, or trusted-Project declarations. Session routes are complete copy-on-write overlays, apply immediately to new launches, and write no files. Global and project edits use optimistic document concurrency through `config/store.ts`, preserve unrelated routes, and require `/reload`. Invalid intermediates never commit. Existing ordered candidates can be added, cloned, moved, removed, disabled, reset, or inherited without reordering another candidate.

The stateful component lives at `src/settings/profile-workspace.ts`; `src/settings/ui/` contains only pure renderers, selectors, and picker projection. Disposal is idempotent. It ignores later input/render/invalidation and discards late save, clear, reload, and catalog UI continuations. Already submitted persistence still settles. Disposal aborts catalog work and the registry refresh, then clears the controller's render callback.

## Model catalog

`src/settings/profile-model-catalog.ts` owns one replace-only immutable snapshot containing projected authenticated Pi models and extension-provider provenance. Registry refresh starts without delaying the overlay and accepts the overlay's abort signal. A successful non-aborted refresh projects the complete next generation and swaps it atomically. Failure, registry error, stale completion, or abort retains the prior snapshot. Each picker action captures one snapshot, so model fields and provenance never mix generations. Host/runtime actions derive the preferred Herdr Pi selector from the latest snapshot at that moment rather than from the snapshot that opened the workspace.

Local Pi offers `parent` plus authenticated canonical selectors. Herdr Pi hides extension-registered providers and fails closed when provider provenance is unavailable. A configured selector that is no longer available remains an explicit current choice, so Enter cannot replace it silently. All provider, parent, and native catalog labels, descriptions, warnings, and search text pass through `sanitizeTerminalLine`; selector values remain unchanged.

Claude and Codex discovery stays cancelable and keeps current/default fallback choices when native discovery fails. Native selector grammar filters advertised entries. Codex fast-mode availability comes only from the captured live catalog's advertised `priority` tier; fallback selectors do not infer it. Pi fast mode uses the canonical static supported-model policy, while `parent` is resolved against the active model at action and launch time.

## Session handoff

The authoritative session route and nesting overlay survives `/tree`. During `/reload`, shutdown publishes only a frozen seed keyed by the current Pi session ID. The new instance first performs a shallow data-descriptor check of every known candidate-array length, without reading candidate elements, then schema-decodes the envelope and reapplies it to the newly loaded persistent base. Oversized or hostile envelopes are discarded. New, resume, fork, quit, and process restart clear the handoff.

## Module responsibilities

- `src/settings/controller.ts` owns root `/subagents`, `/subagents settings`, profile command orchestration, and host lifecycle callbacks. `proxy-controller.ts` owns the packaged nested-Pi subtree command and keeps its visibility root fixed.
- `src/settings/profile-route-editor.ts` owns pure route draft operations and canonical validation messages.
- `src/settings/profile-model-catalog.ts` owns atomic Pi catalog refresh and runtime-specific picker loading.
- `src/settings/profile-workspace.ts` owns asynchronous workspace state and disposal.
- `src/settings/ui/` owns pure workspace rendering, selectors, searchable pages, and sanitized model-choice projection.
