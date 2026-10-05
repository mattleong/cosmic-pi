# Code Previews architecture

## Ownership and host surface

Code Previews owns syntax-highlighted previews, structured diffs, safer write/edit presentation,
appearance settings, and the cooperative tool shell. It registers `/code-previews health` and
`/code-previews settings`, plus `session_start` and `session_shutdown`. One factory-time public
`pi.registerToolRenderer` resolver presents seven core builtins, native `codemode`, and standalone
native MCP tools/resources. Pi 1.0.1 is the minimum; the workspace tests against 1.0.2.

Pi independently owns native codemode/MCP execution and the `/mcp` manager. Code Previews neither
composes nor intercepts their factories, registers their execution definitions, nor changes tool
selection/exposure or permissions. Write alone retains a real before-write snapshot hook.
Standalone MCP presentation has no startup toggle; old unknown settings fields remain inert on
disk. The former standalone `pi-mcp-previews` package is retired and must be removed manually.

## Lifecycle and boundaries

- `src/extension.ts` is the thin entrypoint; `application/lifecycle.ts` coordinates one shared
  core session-runtime slot, trusted settings loading, renderer readiness, syntax initialization,
  replacement, and shutdown. Factory loading registers one resolver; session starts never add more.
- `src/layer.ts` composes private settings, syntax, write, and scheduler dependencies. The final
  Layer retains the Node file platform for effects run through the session capability.
- `application/capability.ts` is the synchronous runtime/defer/schedule bridge. Its run callback
  checks the captured slot token. Deactivation clears the capability and revokes native animation.
  `application/scheduler.ts` scopes deferred and cadence callbacks in a FiberSet; disposal awaits
  remaining fibers. Cooperative extensions can compose its public Layer into their own runtime.
- `boundary/host-tool-renderers.ts` captures public tool and command metadata; a name listed twice
  reads as unknown. `tools/preview-admission.ts` owns the exact-source admission that rendering,
  status and write registration share. The resolver retains only public renderer fields from
  `next()`, and foreign tools fall through unchanged. Core/native
  codemode presentation follows preview selection, not active-at-start status. Native MCP
  definitions require builtin MCP ownership; missing historical aliases require the independently
  proven unique builtin `/mcp` manager. Nothing is introduced or activated for presentation.
- `application/tool-renderers.ts` publishes an originating presentation owner only after trusted
  settings and startup succeed. Rows resolved after readiness get ordinary renderers in Pi's own
  shell. `renderer-row.ts` retains only cold replay call/result slots under a fixed self shell,
  then adopts that owner's first-ready appearance and reconstructs complete arguments/results.
  Old rows retain their appearance and cannot borrow replacement schedulers.
- `tools/renderers/registration.ts` registers only write's execution hook after exact builtin or
  proven prior ownership admission. It preserves activation through `defaultActive`, separates
  attempted ownership from successful installation, and permits retry after mutate-then-refresh
  failures. Discovery failures stop startup; a bounded write registration error keeps rendering
  and the current runtime available.

## Settings and durable publication

`config/store.ts` is the sole public persistence door: Effect `load`, `save`, `flush` and Promise
compatibility helpers. `boundary/settings-one-shot.ts` runs short-lived pre-session access;
ordinary live operations use the active runtime. Signalled loads own cancellation and admission;
unsignalled equivalent loads share disk work but return defensive settings/tools copies.

The process-local `config/coordinator.ts` serializes work across runtime Layers. Monotonic
admissions publish only after newer successful work; failed or interrupted work advances no
currency. The service holds a private complete baseline/loaded Ref. Atomic document modification,
private replacement and projection publication share commit; idle saves rehydrate under the same
permit without intermediate publication. Flush is a global barrier.

Schema-derived tolerant decoding preserves valid siblings. Built-in defaults, global nested
`codePreview`, trusted-project nested settings, then flat global overrides determine values;
there are no environment overrides, and performance budgets are fixed. Untrusted projects are
ignored. Locked latest-document saves touch only edited known overrides, preserve unknown fields
and skip unchanged documents. An override is dropped only when both the project and global
baselines already yield its value; reset removes every known override. Loads publish ignored
files and invalid fields, which session start and health report.
The settings controller uses Cosmic UI's shared command and owned settings surfaces; pure menus
live in `settings/ui/`. Panel drafts roll back only the latest failed edit. Syntax initialization
failure after a successful theme save cannot roll back persistence. Health is an owned overlay,
so closing cannot pop an unrelated stacked surface.

## Presentation and feature state

- `tools/cooperative-tools.ts` and the builtin factories share one renderer adapter. Shell mode
  and collapsed style are captured at wrapping; timing remains live. The root renderer-only
  `withCodePreviewRenderers` accepts no execution/schema; `withCodePreviewShell` preserves an
  extension-owned execution definition. `selfShell: true` retains fixed self framing in every
  appearance mode, including a native-like combined background in preview/on.
- `tools/compact-summary.ts` and bounded schemas define semantic summaries; malformed or absent
  evidence gets conservative generic presentation, never inferred success. `compact-issues.ts`
  merges human messages with expanded-only diagnostics. Preview and compact styles share issues.
- `preview/` owns shell composition, separate original/content-only slot caches, frame/timing,
  children, expanded sections and safe fallback. Expanded content retains complete input/output.
  Slot failures restore raw output without replaying failed renderers. The public
  `getCodePreviewAnimationFrame` reads a safe scalar projection, not mutable timing state.
- Native codemode evidence inspects only the latest 256 own data-property call slots, validates
  neighbors independently and reports missing coverage. Subjects use observed bounded arguments
  and unambiguous MCP aliases. `tools/native-mcp-resource-subject.ts` is the shared argument-only
  resource action/subject seam; it contains no manager or standalone renderer logic.
- Native codemode collapsed source is bounded to eight wrapped rows, with five selected children;
  expansion keeps Program, Calls and Output. Saved-output recovery is informational; missing
  recovery remains a warning. Rendering never reads spill files. Parent and child measured
  subsecond timing obeys settings; retired callbacks cannot use replacement schedulers.
- `tools/native-mcp-render.ts` presents arguments, native output, images and recovery without
  reading retained artifacts. Identity uses exact native metadata, bounded receipts and forward
  SHA matching; missing aliases remain conservative and renderer caches reject foreign ownership.
- Syntax and write services own authoritative state and publish immutable synchronous projections.
  Syntax acquisition/loading and request ingress are bounded and scoped; stale finalization cannot
  clear newer highlighter caches. Write previews retain Pi's direct-write semantics and use bounded
  before-write evidence without destructive renderer lookup. Shared projection tokens prevent
  stale session cleanup from clearing replacement state.
- `diff/`, `paths/`, `warnings/` and builtin projectors own deterministic bounded policy.
  Size/complexity guards, secret warnings, command risks and output limits retain uncertainty;
  unknown history never warrants a new-file claim.

Follow the [tool presentation standard](../../docs/architecture/tool-presentation.md).
The public `testing.ts` harness exercises actual registered callbacks without execution, including
expansion, fallback, animation ownership and native images. Package tests protect lifecycle,
persistence, cancellation and conservative evidence; the env-gated gallery retains builtin and
native codemode and standalone MCP scenarios. SDK and packed-consumer checks keep builtin native
execution independent and prove real fixture execution, images and cleanup.
