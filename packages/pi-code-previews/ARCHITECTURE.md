# Code Previews architecture

## Ownership and host surface

Code Previews owns syntax-highlighted previews, structured diffs, safer write/edit presentation,
appearance settings, and the cooperative tool shell. It registers `/code-previews health` and
`/code-previews settings`, plus `session_start` and `session_shutdown`. Its visible tool surface is
seven core builtin replacements and eligible fresh-native `codemode` styling. It never changes
Pi's active tool names.

Standalone native MCP tools/resources and the native `/mcp` manager belong to the separate,
always-on `pi-mcp-previews` package. Code Previews neither composes that manager nor publishes its
status. There is no MCP startup setting; old unknown fields remain inert on disk.

## Lifecycle and boundaries

- `src/extension.ts` is the thin entrypoint; `application/lifecycle.ts` coordinates one shared
  core session-runtime slot, trusted settings loading, renderer installation, syntax initialization,
  replacement, and shutdown. Capture host context and native codemode eligibility before I/O.
- `src/layer.ts` composes private settings, syntax, write, and scheduler dependencies. The final
  Layer retains the Node file platform for effects run through the session capability.
- `application/capability.ts` is the synchronous runtime/defer/schedule bridge. Its run callback
  checks the captured slot token. Deactivation clears the capability and revokes native animation.
  `application/scheduler.ts` scopes deferred and cadence callbacks in a FiberSet; disposal awaits
  remaining fibers. Cooperative extensions can compose its public Layer into their own runtime.
- Core renderer planning constructs all definitions before mutation. Attempted ownership and
  successful installation are separate; individual registration failures preserve later installs
  and permit retry after mutate-then-refresh failures. Discovery failures stop startup.
- `boundary/host-native-codemode.ts` uses only Pi's public factory to capture a fresh owned
  definition. Registration checks unique public command source and schema identity before and
  after mutation; foreign, missing, inactive, or conflicting tools are not taken over. Execution,
  native schema, hooks, grammar, store callbacks, output and images remain unchanged.

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

Schema-derived tolerant decoding preserves valid siblings. Environment defaults, global nested
`codePreview`, trusted-project nested settings, then flat global overrides determine values.
Untrusted projects are ignored. Locked latest-document saves touch only edited known overrides
and preserve unknown fields. `env.ts` publishes only performance/tool-selection projections.
The settings controller uses Cosmic UI's shared command and owned settings surfaces; pure menus
live in `settings/ui/`. Panel drafts roll back only the latest failed edit. Syntax initialization
failure after a successful theme save cannot roll back persistence. Health is an owned overlay,
so closing cannot pop an unrelated stacked surface.

## Presentation and feature state

- `tools/cooperative-tools.ts` and the builtin factories share one renderer adapter. Shell mode
  and collapsed style are captured at wrapping; timing remains live. Definitions preserve
  execution, results and images. Consumer packages use only the root public API.
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
native codemode scenarios, including nested MCP children.
