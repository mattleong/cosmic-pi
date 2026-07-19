# Pi and platform boundaries

Effect application code is separated from APIs that Pi or third-party libraries require in another shape.

## Approved boundaries

### Pi registration

Extension factories only register callbacks; they do not acquire background resources. `session_start` creates one managed runtime for the started session, and callbacks delegate to it. A callback may pass Pi's `AbortSignal` to the runtime. The runtime is never recreated per event or command.

### Shutdown

The Pi lifecycle boundary disposes the runtime and interrupts session fibers. Finalizers own timers, subscriptions, streams, file handles, HTTP agents, child sessions, and cached resources.

### Synchronous TUI rendering

Pi render methods remain synchronous. Effect services update immutable projection snapshots; renderers only read those snapshots. A renderer must not build a Layer or run an Effect.

### Tool schemas

Pi tool parameter declarations may use TypeBox or literal JSON Schema. Tool execution delegates to Effect immediately. This exception applies to schema representation, not implementation logic.

### Third-party libraries

Promise/callback libraries such as Pi APIs, Sharp, and Shiki are wrapped once with the appropriate Effect constructor in a named adapter. Their native errors are translated into typed domain failures.

### Cross-extension events

Cosmic UI events carry plain data and explicitly checked function capabilities. They never carry Effect services, Layers, refs, scopes, fibers, or runtimes.

## Forbidden internal boundaries

Application services must not:

- call `Effect.run*` or a managed runtime,
- construct unmanaged Promises or timers,
- use global fetch or direct filesystem I/O,
- expose native `Error` or `unknown` in an Effect error channel,
- leak implementation service requirements through public methods.

## Advisor security

Advisor's read-only filesystem capability receives only the narrow filesystem and path Layers it needs. It must not receive an aggregate Node services Layer because that Layer also exposes process-spawning capabilities. Its exact no-process and no-mutation guarantee remains independently tested.
