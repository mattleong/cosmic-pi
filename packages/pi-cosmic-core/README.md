# pi-cosmic-core

Shared Effect v4 foundations for the extensions in the cosmic-pi workspace. This package does not register a Pi extension and does not create a process-wide runtime. It intentionally publishes TypeScript source for Pi's Jiti host rather than generated JavaScript, so installation, reload, testing, and release require no build step.

## Runtime and lifecycle

Pi extension entrypoints create one session runtime at `session_start` through the host-boundary runtime slot. Application Layers own resources, fibers, clocks, state, and finalizers inside that runtime. The slot only performs generation-safe creation, replacement, and idempotent disposal because a runtime cannot own its own construction.

## Shared application services

The package exports:

- typed JSON-document, JSON HTTP, raw streaming HTTP, path, file, and agent-directory services;
- schema-first request/response and tolerant scoped-configuration helpers;
- process-local serialization of each JSON document across independently built runtimes;
- subscription refresh coordination;
- frozen synchronous projections and bounded synchronous ingress for mandatory Pi/TUI edges;
- secret-safe tagged platform errors and telemetry boundaries.

Pure reducers, formatting, parsing of already trusted values, and synchronous rendering remain outside Effect. No API exposes a Ref, Queue, Fiber, Scope, Layer, or runtime to a renderer.

## Test subpath

`pi-cosmic-core/testing` provides the shared fakes that have multiple real consumers: in-memory documents, schema-aware JSON and streaming HTTP Layers, lifecycle probes, bounded yield polling, stable logger/tracer capture snapshots, a fake Windows `taskkill` helper, typed Pi host fixture casts (`extensionApiFixture`, `extensionContextFixture`, `opaqueFixture`), an identity `plainTheme`, `deferredPromise`, and a scoped real-process IPC harness (`temporaryDirectory`, `spawnIpcChild`, `killChild`). Package-specific Pi session harnesses and fault policies stay local until their host shapes genuinely converge; this avoids a broad test abstraction that would erase provider or extension behavior.

See [`docs/architecture/effect-v4.md`](../../docs/architecture/effect-v4.md), [`pi-boundaries.md`](../../docs/architecture/pi-boundaries.md), and [`testing.md`](../../docs/architecture/testing.md) for the complete ownership and exception contracts.
