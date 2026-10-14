# Effect v4 architecture

Effect owns application resources, asynchronous work, expected failures, and coordinated state transitions. Pure policy, parsing of trusted values, reducers, and formatting remain ordinary functions. A function does not need a service or Layer merely to fit a directory pattern.

This document defines shared lifecycle and concurrency guarantees. Package `ARCHITECTURE.md` files explain their owners and tradeoffs; the [boundary guide](pi-boundaries.md) maps integrations. Folder names and module size are navigation aids, not proof of a sound design. Introduce an abstraction when it clarifies ownership, isolates a changing dependency, or enables meaningful testing.

## Services and boundaries

- Import Effect modules through explicit namespace subpaths. Use `Context.Service` with stable language-service keys for injected capabilities, and compose their implementations with Layers. Hide implementation dependencies in Layer construction rather than leaking them through service methods.
- The `make<Name>` prefix is reserved for service constructors, which stay local to their owning module; runtime callers yield the service from its Layer. Name plain value factories and helpers for the value or action they produce. Build tagged values with Schema, tagged class/error, or `Data.taggedEnum` constructors and branch on them with `Match` or `Predicate.isTagged`, not literal `_tag` objects or comparisons. The `anti-slop-effect` lint rules enforce these conventions.
- Keep runners at named Pi or standalone-process boundaries. A resource-owning extension uses core's session-runtime slot to create one runtime at `session_start`, replace it safely, and dispose it explicitly. Registration-only extensions do not need a runtime. Internal services never create or run one.
- Carry the exact `Layer.Error` type through runtime facades. Do not erase initialization failures with casts or default them to `never`.
- Decode unknown input with Effect Schema. Model expected failures with schema-backed tagged errors; reserve defects for broken invariants. Provider-local decoders accept HTTP response bodies. Rejected JSON responses retain their status; streaming boundaries retain only the response evidence their owner needs. Never copy raw bodies into errors or telemetry.
- Use `Effect.try` for callbacks that may throw and `Effect.tryPromise` for Promises that may reject. `Effect.sync` and `Effect.promise` require a total or non-rejecting contract. Translate cleanup rejection into a typed failure even when the caller deliberately recovers it.
- Use Effect clocks, randomness, configuration, scheduling, and scoped concurrency for application work. Narrow synchronous host capabilities are described in the boundary guide. Keep shared platform mechanisms in `pi-cosmic-core`; keep package policy with its owner.

## Resource ownership and cancellation

Use scoped acquisition and release, including `Layer.effect` with `Effect.acquireRelease` for Layer-owned resources. A finalizer releases only something the operation actually acquired: a generated filename is not ownership of a file. Install settlement handlers before admitting an ownership claim, or narrowly mask the claim-to-handler handoff. Waiting for a permit and performing driver work remain interruptible.

Host and third-party Promises are interruptible by default. Mask only an indivisible ownership transfer, ordered cleanup, or irreversible commit, and explain the reason and liveness cost beside non-obvious code. A memoized cleanup must protect both its first-caller handoff and its body; an interruption must not become a permanently cached non-cleanup result. If a foreign API cannot be cancelled, detach and safely handle late settlement when ordering allows it instead of holding scope closure indefinitely.

Shared work has an explicit owner independent of its waiters. Register that owner and its cleanup together; identity-checked cleanup must settle shared waiters and release admission even on interruption. Cancelling a waiter must not abandon an already-owned stop traversal or other required cleanup.

The host session slot is the small imperative owner of runtime creation and replacement. Startup returns activation data through the slot, and only the current generation may publish it. Deactivation synchronously revokes publication and callback authority before asynchronous cleanup. A late durable commit may finish private work, but cannot restore cleared projections or invoke a retired host callback. Check authority in the same synchronous callback as publication or delivery, not before a yielded continuation.

## State, persistence, and projections

Give each state transition one owner. Prefer `Ref` or `SynchronizedRef`; a keyed registry may use plain mutable state behind a semaphore when that makes independent ownership clearer. Every read-modify-write spanning a yield holds its lock for the full transition. Work prepared outside the lock must revalidate its evidence under that lock before committing. A guard checked before an RPC is stale when that RPC returns.

Pi rendering is synchronous. Services publish immutable snapshots for renderers; local input, focus, selection, and layout state may remain in widgets. Rendering does not own application resources or run services. Frozen events and cached slices may be shared when later updates cannot mutate old snapshots.

Keep stale-result validation, state replacement, and context/configuration invalidation in the same serialized transition. Persistence and projection publication must also commit together when interruption could otherwise expose contradictory state. Publishing inside an effectful `SynchronizedRef` callback alone does not protect the backing assignment that follows it.

Core's shared projection primitive keeps preparation and lock waiting interruptible, then commits external publication, its internal snapshot, and authoritative state together. Failed preparation or publication leaves the old state intact. Use this contract rather than rebuilding it inside feature services.

For atomic file replacement, finish creation, writing, validation, and permissions before a narrow uninterruptible rename commit. Nothing fallible follows rename; best-effort cleanup of owned temporary files cannot change the committed result. Preserve supported public interfaces and saved-data contracts deliberately. Avoid accidental internal compatibility layers that leave two owners for the same responsibility.

## Versions and source loading

`pnpm-workspace.yaml` pins jointly released Effect packages to synchronized exact versions; independently versioned tooling is pinned separately. The workspace currently uses stable Effect `4.0.0`. Follow v4 documentation and treat the pinned declarations as authoritative when they differ. Domain APIs can still be marked unstable within a stable release.

Relevant v4 APIs:

- `Context.Service`, `Schema.TaggedError`, and `Layer.effect` are the current service, error, and scoped Layer APIs.
- `ManagedRuntime.make(layer, { memoMap })` takes an options object.
- Pass parser policy directly to schema decoders; annotations do not apply it.
- `Effect.partition` returns successes before failures.
- HTTP, process, RPC, socket, and encoding use published domain subpaths, not `effect/unstable/*`. HTTP receives its Node platform Layer separately; streaming JSON requests use a caller-supplied Codec.
- `@effect/vitest` v4 uses Vitest 5 and exports `it.effect`, `it.live`, and `layer`.

Packages run and publish TypeScript source through Pi/Jiti, with no generated `dist/` dependency or prerequisite build. Declare runtime imports directly in each package. Compiler tooling belongs at the workspace root. All packages inherit the Effect language-service plugin; new or migrated packages extend `tsconfig.effect.json`. Checked standalone JavaScript helpers retain TypeScript and lint coverage.

## Observability

`Effect.withSpan` names stable operations; `Effect.fn("Service.method")` names internal function boundaries and may change with an ordinary refactor. Do not substitute one for the other to satisfy naming conventions. Existing stable operation families are:

- `pi-cosmic-core.runtime.startup`, `pi-cosmic-core.http.{json,streaming}.*`, `pi-cosmic-core.safe-file.initialize`;
- `pi-better-openai.usage.{initialize,refresh}`, `pi-better-openai.image.{request,stream,convert,write}`;
- `pi-cosmic-ui.probe.{git,pull-request}`;
- `pi-code-previews.shiki.initialize`.

Attributes contain only bounded enums, counts, methods, and status codes. Exclude URLs, paths, prompts, bodies, credentials, account identifiers, and raw errors. Core disables upstream URL-bearing HTTP spans and supplies safe spans instead. Redact unknown diagnostics before logs or projections. Extensions do not install process-wide telemetry exporters.

## Validation and upgrades

Run focused package checks, then `pnpm validate`, following the [testing guide](testing.md). TypeScript, Effect diagnostics, type-aware Oxlint, tests, and packaging checks protect different contracts; none replaces the others. Exact-file diagnostic exceptions belong at genuine host boundaries and should stay narrow.

For an Effect upgrade, update synchronized packages together, select tooling compatible with the pinned TypeScript version, review release notes and declarations, then run focused tests, applicable benchmarks, and the complete validation gate. Keep the upgrade isolated from unrelated refactors so failures remain attributable.
