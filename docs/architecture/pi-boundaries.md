# Pi and platform boundaries

A boundary adapts a host or third-party API, establishes resource ownership, and translates failures. Keep it where that integration is understood. Stateless Pi calls can stay at their call sites; pure helpers do not need adapters. Shared mechanisms belong in Cosmic Core or Cosmic UI, while feature policy remains with its package.

The [Effect guide](effect-v4.md) owns lifecycle and commit rules. The [tool presentation contract](tool-presentation.md) owns renderer admission, shell composition, and evidence preservation.

## Registration and session authority

Extension factories register callbacks without acquiring background resources. Resource-owning extensions create one runtime at `session_start` through core's session slot; callbacks delegate to that session rather than constructing runtimes per event. The slot owns generation checks, abort-listener removal, replacement, and idempotent disposal. Application polling and domain state stay inside the runtime.

Capture host context and cancellation capabilities before admitting work. To forward an abort signal without a race, install the listener before inspecting its initial aborted state. Pi's current agent-run signal is turn-dependent and may be absent at session start: capture it again at each operation's admission and retain that exact signal. Release listeners on settlement, failed startup, replacement, and shutdown.

Revoking a session is synchronous even when cleanup is asynchronous. Delayed shutdown cannot clear a replacement session, and late results cannot repaint, notify, open a picker, or send a message for a retired owner. Check generation or invocation authority beside the final host call. A settings write that already committed may complete privately without regaining permission to publish.

Promise and synchronous callback bridges translate throwing host APIs into typed failures or a deliberate neutral fallback. They do not hide service runners in renderers or retain an entire mutable Pi context when a narrow capability will do.

## UI surfaces and rendering

Cosmic UI owns the shared custom-surface, viewport, settings-command, and repaint-ticker adapters. Consumers use those adapters and retain their domain state and failure policy. See [the UI integration API](../../packages/pi-cosmic-ui/docs/extension-authors.md).

Pinned Pi mounts a custom surface after its factory returns, and its `done` callback pops the global overlay stack. The owned-surface adapter therefore latches early finishes, hides only its owned handle, adds an inert non-capturing guard, calls `done`, and removes the guard in `finally`. This protects unrelated overlays, including those mounted later. Revisit the workaround when Pi supports closing by identity. Retained viewport options must be passed by identity because Pi reads their live properties during rendering.

A successful mount is not a completed questionnaire; a returned `sendMessage` call is submission, not model acknowledgement. Async presenters and delivery belong to the session scope independently of an individual tool waiter. Ask User's branch receipts and generation checks govern historical delivery. Editor cleanup must restore the TUI and release owned temporary files before transferring the dialog permit, without waiting forever for an unrelated host Promise. See [Ask User ownership](../../packages/pi-ask-user/ARCHITECTURE.md).

Render methods remain synchronous. Widgets may own local input, focus, selection, and caches; services own application state, resources, and asynchronous work. Renderers consume immutable projections or explicitly guarded synchronous capabilities, never build Layers or run Effects. Cosmic UI's synchronous footer store may keep presentation state directly. Live host getters pass through guarded callbacks before layout uses them. Shiki's synchronous highlighter is a scoped capability paired with immutable metadata; disposal of an old highlighter must not clear a newer cache.

## Tool and native-manager integration

Pi owns native codemode, tool search, and MCP execution, permissions, cancellation, discovery, activation, authentication, connections, result storage, and native images. Code Previews supplies public renderer callbacks after exact source admission. It does not compose native factories, replace `/mcp`, inspect private execution definitions, or change exposure. Unknown historical MCP aliases need proof from the independently owned builtin manager; names alone cannot establish identity.

Write's genuine before-write snapshot hook is the single presentation-related execution exception. It preserves Pi's mutation queue, activation, direct-write semantics, and cancellation. Queue waiting remains interruptible; once a write is admitted, its mutation and matching evidence settle before the queue is released. A delayed queue entry cannot enter a retired or replacement runtime. Other owned tools retain their ordinary executable registration; presentation alone never registers foreign execution.

Code Previews requires Pi 1.4.0 or later and is tested with 1.4.0. Existing standalone MCP Previews installations require manual removal; never edit user configuration automatically. See the [native migration guide](../migrations/native-mcp-codemode.md).

Pi parameter schemas may use TypeBox or literal JSON Schema. Effect Schema owns output contracts; `toPiToolOutputSchema` generates Pi's self-contained declaration, and producers encode results with the matching codec. Execution enters the owning service through a named host boundary.

## Cross-extension capabilities

Cross-extension events carry bounded plain data and explicitly checked function capabilities, never services, Layers, refs, scopes, fibers, or runtimes. Consumers import narrow public protocol/client subpaths rather than extension roots. Callback failures are isolated and raw payloads are not retained as diagnostics.

Cosmic UI providers use session identity, host activation, and registration ownership to reject stale updates and actions. Widget availability is acknowledged only after installation, and producers keep fallback UI until acknowledgement. Deferred actions recheck revision and generation, receive cancellation, and return bounded redacted content. The host owns presentation; feature packages remain authoritative for agents, processes, and questionnaires. See the [activity protocol](../../packages/pi-cosmic-ui/docs/activity.md).

Explicitly routed Pi-child questionnaires use authenticated assignment ownership and exact-owner cancellation acknowledgement. Subagent cleanup joins questionnaire/editor finalizers; it does not make waiting for an answer uninterruptible. Parent coordination questions remain a separate protocol.

## Model-visible extension messages

Pi sends a custom message (`pi.sendMessage`, or a `custom_message` settle entry) to the model as ordinary user text. An extension that keeps custom messages in model context registers them once, at factory time, with core's [`registerMessageOrigins`](../../packages/pi-cosmic-core/src/host-message-origin.ts), naming each type and who writes its content. Its `context` handler wraps each matching message, for that request only, in a marker; `source` names the extension:

```text
<pi_extension_message source="pi-subagents" type="pi-subagents-completed" origin="automated extension message relaying reports and outcomes from subagent agent-k3m9x2q7ra; not typed by the user">
…the stored content…
</pi_extension_message>
```

- **Truthful origins.** Text the extension writes is `extension`. Text another agent, Pi session, or process wrote is `other`, naming that author, such as a subagent's report or another session's agent. Words the user wrote, such as questionnaire answers or an image command's result, are `user`, labeled as relayed by the extension and never as automated or "not typed by the user". The owning package decides each type's origin; core only renders it.
- **Deterministic bytes, system messages in place.** The origin derives only from the message's type and `details` (`originFromDetails`), which Pi stores but never sends, so the same stored message renders the same marker every turn. Undecodable details fall back to a generic origin of the same kind. Pi folds every system message into one leading message once a `context` handler returns a list or replaces an element, so the handler replaces only each matching element's content in place and returns nothing: mid-conversation prompt and tool changes stay where they are, and marking alone never rewrites a cached prefix. Sessions resumed after upgrading miss the prompt cache once, because their history is now marked.
- **No breakout.** A `<` or fullwidth `＜` that starts an opening or closing marker inside content is escaped, whatever its case, `-` or `_` spelling, whitespace, or invisible format characters around the `/` and inside the name, and also when the marker is split across adjacent text parts. Other text, including emoji joiner sequences, is untouched, and attribute values are escaped.
- **Request only.** Pi runs `context` handlers on a copy of the transcript, so the stored session, the chat view, renderers, and settle checks still see the original content. Mutating that copy relies on Pi's behavior rather than its documented contract; core's tests drive Pi's own `ExtensionRunner` to pin it. String and content-array forms, image parts, and every other message, with its identity and order, are kept.
- **Ordering and composition.** `context` handlers all run before any `context_with_system` handler, which chain in extension load order, so marking always precedes Better OpenAI's checkpoint repair. That repair accepts a marked message as its stored original (`withOriginMarkerOf`) and rebuilds the checkpointed prefix from stored messages, so a checkpointed session sends that prefix unmarked; marking after it would change checkpoint-covered messages and stop the checkpoint from replacing them. Filters such as Ask User's receipt check and other extensions' markers compose in any order.

Messages that arrive as Pi user prompts, such as an agent message sent into a subagent child over RPC, are outside this contract and rely on their own framing.

## Filesystem, process, and security adapters

Use core's scoped platform mechanisms for ordinary I/O. Specialized adapters may own filesystem, process, socket, or VM behavior when their protocol requires it; keep permissions, limits, failure translation, and cleanup explicit. Do not spread direct I/O or runtime helpers through domain services. Exact diagnostic exceptions should track these boundaries rather than an arbitrary folder convention.

Processes and native libraries require observed cleanup, not merely a timeout or successful kill request. Fixed packaged helpers use bounded input/output, controlled arguments and environment, and scoped process ownership. Better OpenAI's decoder keeps admission until exit is confirmed; uncertain cleanup disables further decoding. Its byte/pixel/deadline bounds are work limits, not an OS sandbox.

Subagents owns authenticated supervision, writer leases, workspace proposals, and integration journals. A backend process ending does not delete its durable proposal or authorize adoption after reload. Integration revalidates source state and exact reviewed revisions; partial multi-file publication retains recovery evidence. Cooperative claims and worktrees do not restrict the local user's filesystem authority. Rex BTW similarly reports an uncertain pane split rather than retrying an operation that may already have succeeded.

Core supplies synchronous entropy/UUID and text-identity helpers where an asynchronous gap would break a native ownership commit. Native asynchronous authentication still runs under Effect and rechecks revocation before publishing its result. Narrow unsafe calls belong at synchronous ingress or shared admission boundaries with explicit ownership, not in ordinary services.

## Package ownership map

Detailed integration constraints live with their owners:

| Package                                                                | Owned boundary                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Cosmic Core](../../packages/pi-cosmic-core/ARCHITECTURE.md)           | Session runtimes, safe files, typed HTTP, shared process/locking primitives, projections, host callbacks, and test adapters |
| [Cosmic UI](../../packages/pi-cosmic-ui/ARCHITECTURE.md)               | Footer and activity protocols, owned surfaces, settings commands, viewport and repaint adapters                             |
| [Code Previews](../../packages/pi-code-previews/ARCHITECTURE.md)       | Renderer resolution/replay, settings publication, syntax resources, and before-write evidence                               |
| [Ask User](../../packages/pi-ask-user/ARCHITECTURE.md)                 | Questionnaire admission, TUI/RPC dialogs, answer delivery, and external-editor cleanup                                      |
| [Background Tasks](../../packages/pi-background-task/ARCHITECTURE.md)  | Task process lifecycle, bounded logs, and manager projection                                                                |
| [Subagents](../../packages/pi-subagents/ARCHITECTURE.md)               | Run coordination, in-session agent messaging, child/native transports, and workspace ownership                              |
| [Better OpenAI](../../packages/pi-better-openai/ARCHITECTURE.md)       | Provider schemas/configuration, usage refresh, request policy, and image decoding/output                                    |
| [Directory Models](../../packages/pi-directory-models/ARCHITECTURE.md) | Directory preferences and host model selection                                                                              |
| [Intercom](../../packages/pi-intercom/ARCHITECTURE.md)                 | Cross-session registry records, session sockets, inbound message delivery, and the sweep of dead owners                     |
| [Rex BTW](../../packages/pi-rex-btw/ARCHITECTURE.md)                   | Fixed Rex CLI interaction, BTW pane placement, and the child's parent-transcript reference                                  |

Change these boundaries when it removes coupling or clarifies authority. Preserve cancellation and security guarantees, and update the owning document alongside the change.
