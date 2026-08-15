# Routing, candidate planning, and the public launch contract

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the package purpose, the complete source map, and the invariant summaries linking every topic document.

## Version-4 routing domain

A normalized candidate has `host`, `runtime`, `model`, `effort`, `context`, `writeIntent`, `fastMode`, and `closeOnReport`. Routes are disabled, one candidate, or ordered candidates. Configuration has no denied/discouraged policy, execution, lifetime, or generic tool-policy fields.

All six `local|herdr` × `pi|claude|codex` combinations are syntactically representable. Cross-field decoding rejects:

- fork outside local Pi;
- parent-model selection outside local Pi;
- `closeOnReport: false` outside Herdr read-only candidates;
- fast mode outside supported Pi OpenAI routes or Codex's priority-tier-capable native path;
- unknown candidate keys, runtime-incompatible effort levels, or malformed native selectors (Pi registry IDs may use bounded `@` context variants such as `cursor/gpt-5.5@1m`; Claude's exact numeric long-context suffixes such as `[1m]` are supported without admitting general glob syntax).

A present-invalid route fails closed. Missing trusted-project routes inherit global routes; missing global routes use built-ins. A complete in-memory session route overlays that loaded persistent result and records source `session`; removing it reveals the exact activation-time base again. Every built-in is an explicit local Pi parent candidate using profile context, write-intent, and effort defaults with `fastMode: false` and `closeOnReport: true`. Omitted launch profiles always resolve to `generalist`; only the seven declared profile IDs are accepted.

Only version 4 and its exact root/candidate fields are accepted. Other versions and unknown fields fail activation; no migration or normalization path exists.

## Candidate planning and host resolution

Pure planning preserves declared order and resolves Pi model catalog/auth compatibility for local and Herdr Pi. Because sterile Herdr Pi disables extension discovery, the host boundary reads Pi's registered-provider provenance before model resolution and rejects every extension-registered provider before auth lookup or service ownership; provenance failure also fails closed. This provider-granular rule deliberately rejects a built-in provider while any extension overrides it, preventing credentials intended for extension routing from falling back to the built-in endpoint. Runtime credentials and environment-sourced Herdr-Pi API keys are resolved before service ownership and transferred only through the private ephemeral bootstrap; absent or malformed transferable credentials produce a typed candidate skip. The host boundary records dynamic typed skips in launch provenance. Host resolution continues to the next candidate only before service ownership begins.

All six adapters are implemented. The shared registry resolves host/runtime/context and performs bounded executable/auth/model-effort/write-policy/integration/harness readiness before a run scope, writer lease, supervisor channel, topology, or backend process is owned. Once `SubagentService.start` begins, lease marking, topology mutation, spawn, transport uncertainty, or control errors never trigger candidate fallthrough.

Selected host, runtime, route source, `fastMode`, and `closeOnReport` are retained in selection provenance, the internal start request, the run view, status output, and card details. Start-entry details additionally preserve the requested profile and concrete actual route/model for success, the attempted route/model after post-selection failure, or an explicit resolving/no-eligible-route discriminant. Each public start batch captures one immutable profile snapshot before resolving its agents, so concurrent session edits cannot split a batch across route revisions. Persisted cards decode only at the current details version.

## Public launch contract

`subagent_start` accepts one required array of 1–12 agents. Each item contains only:

- required `task`;
- optional `profile`;
- optional `name`.

The TypeBox object is strict, and the service boundary independently rejects unknown launch overrides with `launch_override_not_allowed`.

Start is always background and nonblocking. The public tool executes all admitted batch items without waiting. `subagent_await` supports `all_finished` and `any_finished` semantics.

Main-agent prompt metadata follows a read-only-first adoption policy: before substantial work, check for at least two independent workstreams; launch one to three bounded read-only assignments early; skip delegation for trivial or tightly serial work; continue independent parent work after launch; and await only at a dependency or final-synthesis barrier because unclaimed completion reports are delivered automatically. Worker launches remain explicit implementation handoffs: the prompt requires the main agent not to edit and preserves the one-shared-cwd-writer rule.

`subagent_models` projects all complete v4 candidates as statically eligible when their adapter/context contract matches; dynamic executable/auth/integration/harness readiness remains launch-time.

## Module responsibilities

Detailed responsibilities of the source files owning the behavior above:

- `src/domain/routing.ts` — import-free leaf routing vocabulary: context/write-intent/host/runtime types, the effort scale, the shared runtime-native effort policy, and host-effort decoding. Profiles, config, run, backends, boundaries, and settings all import it directly, so the profile and run models stay cycle-free.
- `src/profiles/` — fixed definitions, explicit built-in routes, ordered candidate planning, and a revisioned Effect-owned session override service. `session-overrides.ts` owns immutable overlay snapshots and conflict transitions.
- `src/boundary/host-profile-resolution.ts` — Pi model/auth capture (local or Herdr) and ordered dynamic candidate consumption. Typed readiness failures fall through only before service start.
