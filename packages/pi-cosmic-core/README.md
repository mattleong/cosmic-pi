# pi-cosmic-core

Shared Effect v4 foundations for the Cosmic Pi extensions. It's a library, not a Pi extension: it registers nothing and has no process-wide runtime of its own.

## Features

- **Session runtimes:** a runtime slot that creates one Effect runtime per Pi session and replaces or disposes it safely.
- **Platform services:** typed JSON documents, JSON and streaming HTTP, files, paths, the agent directory, and cross-process locks.
- **Configuration helpers:** schema-first scoped config stores and tolerant decoding that keeps valid fields when others are invalid.
- **Coordination:** single-flight refresh, subscription polling, and per-file serialization across independent runtimes.
- **Host edges:** the shared `/<extension>` command registrar, settings argument parsing, session capture helpers, and Pi tool output schemas.
- **Security:** secret-safe tagged errors, redaction, and terminal sanitization.
- **Test kit:** `pi-cosmic-core/testing` with in-memory documents, fake HTTP layers, lifecycle probes, Pi host fixtures and a recording extension host, and a real-process IPC harness; `pi-cosmic-core/testing/sdk` runs real Pi SDK sessions with faux inference.

## Install

There's nothing to install in Pi; the extensions that need it bring it along. Inside this workspace, add it to a package's runtime dependencies with the workspace's pinned Effect version:

```json
{
  "dependencies": {
    "effect": "catalog:",
    "pi-cosmic-core": "workspace:*"
  }
}
```

## Usage

Import services from the package root and test helpers from `pi-cosmic-core/testing`:

```ts
import {
  JsonDocumentStore,
  makePiSessionRuntimeSlot,
  registerExtensionCommand,
} from "pi-cosmic-core";
import { extensionApiFixture } from "pi-cosmic-core/testing";
```

Create the session runtime at `session_start` through the runtime slot, and keep resources, fibers, and state inside that runtime's Layers. Pure reducers, formatting, and synchronous rendering stay outside Effect, and no API hands a `Ref`, `Fiber`, `Scope`, or runtime to a renderer.

## How it works

The package ships TypeScript source that Pi's Jiti loader runs directly, so there's no build step. The runtime slot handles only generation-safe creation, replacement, and idempotent disposal, because a runtime can't own its own construction; everything else is scoped inside the runtime. Package-specific fakes stay in their packages until at least two consumers need the same one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, and [effect-v4.md](../../docs/architecture/effect-v4.md), [pi-boundaries.md](../../docs/architecture/pi-boundaries.md), and [testing.md](../../docs/architecture/testing.md) for the workspace conventions.
