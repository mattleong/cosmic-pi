# Better OpenAI architecture

Better OpenAI adds subscription usage, fast-mode request injection, provider-native
compaction, image generation, and settings to Pi. This document maps ownership and
the invariants that make those integrations safe. Module boundaries may change
while those responsibilities remain explicit.

## Ownership and dependencies

| Owner                                                                 | Responsibility                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Application](src/application.ts) and [Layer](src/layer.ts)           | Pi commands/events, one session runtime, activation authority, synchronous projections, and service composition.      |
| [Config store](src/config/store.ts)                                   | Resolved configuration, serialized settings/fast commits, and committed-config notifications to consumers.            |
| [Usage](src/usage/controller.ts)                                      | Refresh admission, polling, stale-result rejection, and usage projections.                                            |
| [Fast mode](src/fast/service.ts)                                      | Desired versus model-eligible state and the scoped ingress for synchronous request-injection receipts.                |
| [Compaction](src/compaction/service.ts)                               | Owned checkpoints, complete-context reconstruction, encrypted reuse, and safe native fallback.                        |
| [Images](src/image/service.ts)                                        | A captured request context/configuration, bounded streaming, validation, and file publication.                        |
| [Settings](src/settings/controller.ts) and [UI](src/ui/primitives.ts) | Package-specific settings actions and pure footer data. Cosmic UI owns the shared settings surface and custom footer. |

Core supplies runtime, configuration, HTTP, process, and file primitives. Code
Previews supplies the image tool's presentation shell and replay bridge. Pi owns
authentication refresh, tool execution, transcript persistence, and native image
rendering. [Codex auth](src/auth/codex-auth.ts) obtains credentials only through
Pi's model registry and keeps them redacted until the HTTP boundary. Provider
bodies, native decoder errors, and secrets stay out of diagnostics.

## Lifecycle and configuration

Factory loading registers `/openai`, the service-free `openai-image` message
renderer, and the renderer-only image replay bridge. `session_start` creates the
session runtime, loads trusted preview settings, initializes services, and activates
the current session's image command/tool and request-injection ingress. The replay
bridge publishes only after successful tool registration; startup settlement
closes unsuccessful adoption. Replacement or shutdown revokes publication and
scheduling authority before clearing projections and disposing scoped work.

Commands and retained tool definitions capture their originating session's
authority. Delayed UI callbacks and queued image delivery check it beside the host
action, so an old invocation cannot enter a replacement runtime or repaint its UI.
A retired durable commit may finish privately; it cannot restore projections or
notify. Compaction hooks capture the same authority: retirement cancels pending
compaction and prevents delayed context repair or payload rewrites from reaching
the host. See [compaction lifecycle tests](tests/compaction-lifecycle.test.ts),
[extension lifecycle tests](tests/extension.test.ts),
[image admission/delivery tests](tests/image-registration.test.ts), and
[host failure tests](tests/host-ui.test.ts).

`OpenAIConfigService` owns configuration independently of usage. Settings and fast
mode commit through it; images and compaction read its dedicated configuration
projection. Usage registers a scoped observer under the configuration update gate
before starting polling, so initialization cannot miss a concurrent change.
Project configuration requires explicit trust, and writes preserve unknown JSON
fields. A durable fast transition commits its document, private state, and
synchronous projection together through the store's `afterCommit` region, without
reacquiring the fast permit.
Waiting and preparation remain interruptible. Startup writes only when `--fast`
changes resolved intent; model switches stay in memory. Fast-only commits preserve
in-flight usage results and do not wake polling. See [config tests](tests/config.test.ts),
[config service tests](tests/config-service.test.ts), and
[fast commit tests](tests/fast-service.test.ts).

Session start, fast toggles, and model switches close the session's pooled Codex
sockets through Pi's session cleanup registry, never without a session id, so the
next request reconnects with current routing headers and full context. A busy
session defers the reset until its next `before_provider_headers`; shutdown drops
a pending reset. See [transport reset tests](tests/codex-transport-reset.test.ts).

Usage visibility comes from Cosmic UI: hiding it suppresses automatic requests
and both footer/status output paths, while `/openai usage` remains available.
Visibility/context changes invalidate pending usage results. Services publish
immutable snapshots; synchronous renderers and provider hooks read those snapshots
without running effects. Shared host rules are in
[Pi boundaries](../../docs/architecture/pi-boundaries.md).

## Compaction and transcript authority

[Projection](src/compaction/projection.ts) uses public Pi transcript APIs and
pi-ai's Responses converters, with the native provider's tool and grammar options.
Injection also emits per-reply `configuration_update` items when the provider
payload carries them. Projection and injection omit the same leading instruction
prefix while preserving later system updates. Checkpoints live in ordinary
branch-local compaction entries with typed extension details; the original branch
remains navigable.

Pi's extension loader aliases only pi-ai's root, `compat`, `models`, `oauth`, and
`providers/all` entrypoints, so the converters' public `api/*` and `utils/*`
subpaths load this package's pi-ai copy. New checkpoints are created only when
that copy's `PI_AI_VERSION` equals Pi's; otherwise Pi compacts and Better OpenAI
warns. Repair and injection still use existing checkpoints, because injection
replaces only a covered prefix that exactly matches Pi's payload.

[Context reconstruction](src/compaction/context.ts) remains active for an owned
checkpoint even after compaction is disabled or the model changes. It reconstructs
complete plaintext, including tool results/images, canonical system updates, and
branch-local context edits, without mutating history or crossing an earlier
ordinary Pi compaction boundary. Retry omissions are accepted only for eligible
assistant responses on the active branch; stored omission metadata cannot delete
user, system, tool, successful assistant, or future-tail messages.

Repair uses `context_with_system` because Pi's conversation-only hook cannot repair
prompt/tool authority. It replaces only a verified native session prefix and keeps
other extensions' appended context. Failed repair aborts the request: Pi otherwise
contains extension exceptions and could continue with incomplete context.
Encrypted reuse additionally requires matching-model, JSON-equivalent provider
prefixes. New covered omissions or edits invalidate reuse; complete plaintext is
the safe alternative. See [context tests](tests/compaction-context.test.ts) and
[projection tests](tests/compaction-projection.test.ts).

[Fallback](src/compaction/fallback.ts) prepares native compaction from that same
reconstructed history through public Pi APIs, preserving tool groups, prior
ordinary summaries, file operations, auth, routing, and Pi's retry settings. It
cancels if no safe cut exists or Pi would persist a stale system/tool snapshot that
supersedes repair. It never hands Pi incomplete preparation. Usage is returned on the native
compaction result; cost remains Pi's catalog estimate for the captured model.
See [compaction service tests](tests/compaction-service.test.ts).

## Image isolation and publication

[Input](src/image/input.ts) enforces workspace containment.
[Output](src/image/output.ts) validates generated bytes and owns temporary files
by identity. It closes the written/synced file before publication, then commits at
an exclusive hard link. Cleanup removes only the owned temporary file; a
post-commit identity mismatch never removes a destination that may now belong to
someone else. [Resource tests](tests/image-resources.test.ts) protect collisions,
interruption, and lost verification.

[Sharp](src/boundary/sharp.ts) runs only in the shipped
[one-shot decoder](src/boundary/sharp-decoder.mjs), through core's bounded process
runner with a fixed executable/helper and no shell or caller-supplied environment.
It fully decodes animation pages under byte/pixel/output limits; only bounded,
schema-decoded format metadata returns. One process-wide immediate permit rejects
busy calls instead of queuing image buffers and remains held through cleanup.
Decoding stays disabled after unconfirmed child exit, including partial spawn:
scope success or a successful kill request is not proof of termination. Deadlines
and process isolation are neither an OS memory sandbox nor an unconditional
shutdown deadline. See [adapter tests](tests/sharp.test.ts) and
[real-process tests](tests/sharp-process.test.ts).

[Tool-result projection](src/image/tool-result.ts) owns the versioned structured
result. Normal content keeps one native image and byte-free details; structured
encoding failure preserves the generated receipt instead of rolling it back.
The [native codemode contract](README.md#native-codemode) explains retention and
host limits; [SDK tests](tests/native-codemode.test.ts) verify the pinned host.

Image commands and tools share classification and content rendering. Historical
replay never executes images or borrows a later session's settings/scheduler.
Custom messages can render before startup without restoring delivery authority.
See [replay tests](tests/tool-replay.test.ts) and the
[shared presentation contract](../../docs/architecture/tool-presentation.md).
