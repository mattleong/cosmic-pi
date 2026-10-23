# pi-cosmic-core

Shared Effect v4 foundations for the Cosmic Pi extensions. It's a library, not a Pi extension: it registers nothing and has no process-wide runtime of its own.

## Features

- **Session runtimes:** a runtime slot that creates one Effect runtime per Pi session and replaces or disposes it safely.
- **Platform services:** typed JSON documents, JSON and streaming HTTP, files, paths, the agent directory, and cross-process locks.
- **Configuration helpers:** schema-first scoped config stores and tolerant decoding that keeps valid fields when others are invalid.
- **Coordination:** single-flight refresh, subscription polling, and per-file serialization across independent runtimes and Pi processes.
- **Host edges:** the shared `/<extension>` command registrar, settings argument parsing, session capture helpers, Pi tool output schemas, and `ForeignCallable` for functions received from other extensions.
- **Tool arguments:** `pi-cosmic-core/tool-arguments` builds Pi `prepareArguments` hooks that drop blank optional fields, and nulls their schemas reject as Pi does, then validate with Pi's own validation and report precise, bounded errors; `keepWhitespace` names fields whose whitespace-only text is meaningful, and a union reports only the branch selected by an enum or const property, such as `mode`, that every branch declares.
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

Import services through narrow public entrypoints and test helpers from `pi-cosmic-core/testing`:

```ts
import { JsonDocumentStore } from "pi-cosmic-core/platform/json-document";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";
import { extensionApiFixture } from "pi-cosmic-core/testing";
```

Tool-owning packages, which already provide `typebox` and `@earendil-works/pi-ai`, prepare arguments through their own entrypoint:

```ts
import { toolArgumentPreparer } from "pi-cosmic-core/tool-arguments";

pi.registerTool({
  name: "task_start",
  parameters: Parameters,
  // Returns `Static<typeof Parameters>`, checked against the same schema.
  prepareArguments: toolArgumentPreparer("task_start", Parameters, {
    aliases: { prompt: "task" },
  }),
  // ...
});
```

Functions received from another extension, such as a capability's callbacks, are admitted with `ForeignCallable` in an Effect Schema. It checks only that the value is callable; the parameter types are a documented contract that can't be verified at runtime, and the `void` result is untrusted. Invoke it through `Effect.try` or `Effect.tryPromise`, or `invokeBestEffort` on a synchronous host path, and decode what it returns:

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";

const Capability = Schema.Struct({ ask: ForeignCallable<[question: string]>() });

const ask = (capability: typeof Capability.Type, question: string) =>
  Effect.tryPromise({
    try: () => Promise.resolve<unknown>(capability.ask(question)),
    catch: () => new CapabilityError(),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Answer)));
```

Create the session runtime at `session_start` through the runtime slot, and keep resources, fibers, and state inside that runtime's Layers. Pure reducers, formatting, and synchronous rendering stay outside Effect, and no API hands a `Ref`, `Fiber`, `Scope`, or runtime to a renderer.

## Public entrypoints

The root remains supported, with unchanged exports and service identities, but eagerly reaches every
platform implementation. Prefer the narrow module that owns the capability; the [package export
map](package.json) lists the complete public surface. All paths load TypeScript source directly, with
no generated build.

| Entrypoint suffix                                                                                                                      | Use                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `host-environment`                                                                                                                     | Dependency-free `isSubagentChildProcess` admission guard                |
| `text`, `text-scan`, `display`, `message-text`                                                                                         | Text scans, bounded text, formatting, and message summaries             |
| `security`, `security/terminal-styled`, `security/sha256`                                                                              | Redaction, terminal safety, and hashing                                 |
| `schema/decode`, `schema/foreign-callable`, `schema/tool-output`                                                                       | Unknown input, foreign callbacks, and tool output schemas               |
| `host-session`, `host-command`, `host-wake`, `host-transcript`, `host-agent-messages`                                                  | Host callbacks, commands, delivery, and transcript helpers              |
| `session-capability`, `settings-completion`, `settings-dispatch`                                                                       | Capability exchange and settings routing                                |
| `runtime`                                                                                                                              | Managed runtime creation, abort forwarding, and quiet host logging      |
| `runtime/pi-api`, `runtime/session-runtime`, `runtime/host-bootstrap`                                                                  | Pi API service, session authority, and best-effort startup              |
| `runtime-values`, `projection`                                                                                                         | Runtime type descriptions and immutable snapshots                       |
| `coordination/listeners`, `coordination/refresh-coordinator`, `coordination/subscription-refresh`, `coordination/synchronous-ingress`  | Publication and refresh coordination                                    |
| `config/tolerant-fields`, `config/document-ops`, `config/scoped-config-store`                                                          | Configuration decoding and persistence                                  |
| `platform/node-file`                                                                                                                   | `nodeFilePlatformLayer`: documents, filesystem, and paths, without HTTP |
| `platform/json-document`, `platform/safe-file`, `platform/private-file`, `platform/paths`, `platform/agent-directory`                  | Individual file and path capabilities                                   |
| `platform/node`                                                                                                                        | `nodePlatformLayer`: the file platform plus HTTP                        |
| `http/headers`, `platform/json-http`, `platform/streaming-http`, `platform/errors`                                                     | HTTP helpers, clients, and typed platform errors                        |
| `platform/process`, `platform/process-tree`, `platform/process-group-exit-guard`, `platform/process-start`                             | Explicit process execution, cleanup, and identity                       |
| `platform/cross-process-lock`, `platform/bounded-ndjson-rpc`                                                                           | Same-host locking and bounded RPC framing                               |
| `platform/native-clock`, `platform/native-crypto`, `platform/token-verifier`, `platform/node-builtins`, `platform/shell-process-names` | Native synchronous boundaries and process-name policy                   |
| `tool-arguments`, `testing`, `testing/sdk`                                                                                             | Optional tool preparation and test integrations                         |

Subpaths export the existing modules directly, not copies of their services or wrapper Layers.
File operations keep their cross-process safety checks; only an asynchronous macOS liveness probe
loads the bounded process runner on demand. Narrow helper imports do not acquire resources.

## How it works

The package ships TypeScript source that Pi's Jiti loader runs directly, so there's no build step. The runtime slot handles only generation-safe creation, replacement, and idempotent disposal, because a runtime can't own its own construction; everything else is scoped inside the runtime. Package-specific fakes stay in their packages until at least two consumers need the same one.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, and [effect-v4.md](../../docs/architecture/effect-v4.md), [pi-boundaries.md](../../docs/architecture/pi-boundaries.md), and [testing.md](../../docs/architecture/testing.md) for the workspace conventions.
