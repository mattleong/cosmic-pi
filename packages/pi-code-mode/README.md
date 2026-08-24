# pi-code-mode

Code Mode for pi: one `code_mode` agent tool that runs a confined, interpreted JavaScript
program orchestrating all seven Pi built-ins (`tools.pi.read`, `tools.pi.bash`,
`tools.pi.edit`, `tools.pi.write`, `tools.pi.grep`, `tools.pi.find`, `tools.pi.ls`) in a
single tool call, with trusted-project-only scoped settings.

The program is TypeScript-transpiled, Acorn-parsed, and executed by a vendored tree-walk
interpreter (OpenCode 2 Code Mode; see ADR 0003) — never `eval`, `Function`, `node:vm`, or a
child JavaScript process. The interpreter provides no ambient filesystem, network, process,
environment, module, or timer APIs; programs can only call the supplied tool tree and the
runtime's own `tools.$codemode.search` discovery tool. Supplied Bash, edit, and write tools
intentionally confer full local-user process, network, environment, and unrestricted
filesystem authority (ADR 0004). The interpreter lives in the private
`pi-code-mode-runtime` workspace package nested at `runtime/` inside this package; its
TypeScript `runtime/src/` tree ships inside this package and Pi/Jiti loads it directly.

Because the interpreter runs in the agent process, the runtime adds an in-process confinement
layer so a single native operation cannot block the event loop for seconds (a synchronous
native call cannot be preempted by the timeout once it starts): regular expressions with
catastrophic- or polynomial-backtracking structure (nested quantifiers, repeated
alternation, backreferences, inline flag-modifier groups like `(?i:...)`, more than 3
unbounded quantifiers/lookarounds, oversized
optional branch factors) are conservatively refused, admitted regex operations are
subject-length capped by backtracking degree and branch factor, string/collection/log growth
is bounded by preflight guards that refuse projected overruns before native allocation
(forged array-like lengths, flat/merge projections, and percent-encoding expansion
included), and a wall-clock deadline normalizes any synchronous overrun to a timeout
diagnostic. The deadline is cooperative and the screens are conservative: this is not
mathematical preemption of native execution — an admitted native operation still runs to
completion, bounded to a small worst case — and some safe patterns are rejected in exchange.
See the runtime `PROVENANCE.md` (deviation 8) for the exact rules.

## TUI presentation

In the TUI a `code_mode` call renders compactly as `Code Mode · <intent>` — the optional
`intent` tool parameter (a short human-readable purpose the model is asked to provide),
falling back to a neutral phrase. Execution publishes an immediate `Starting…` state. New
nested rows and their enriched running labels bypass extension-side scheduling so they can join
Pi's already-pending next render; status-only churn is coalesced to Pi's 16 ms host-render
cadence by one `Effect.runCallback` interruptor, and settlement always flushes the latest state. This avoids stacking two frame delays
or slowing the program merely to preserve transient animation; a sub-frame call may still first
paint as completed. While the program runs, nested calls appear as bounded activity rows
derived from their inputs,
reusing the standalone built-in tool emojis alongside status (`◌` queued, an animated Braille
spinner while running, `✓` succeeded, `✗` failed, `⊘` cancelled), with settled durations and an
exact lifecycle footer. Beyond 32 rows, the visible slots prioritize active, failed, cancelled,
and recent calls under a `+N earlier` marker; the bound can still hide rows. Exact counts include
all hidden calls, including cancellation before a queued call starts. Expanding the call
shows the full program source; expanding the result shows the complete model-visible output
or error. Successful object results containing only top-level string fields, including at least
one multiline value, are projected as labeled sections instead of escaped JSON, using
extension-only result metadata so a string that merely
contains JSON is never reinterpreted. The tool definition captures, sanitizes, and bounds the
configured `app.tools.expand` keys once; collapsed hints reuse that snapshot
(`▸ output · ctrl+o expand`). All displayed text is
sanitized against terminal control injection, and result-projection failures retain a fail-soft
custom result instead of surrendering to Pi's raw generic fallback.
Presentation never changes the model-visible result, details, or any execution limit.

## Full built-in authority and direct nested dispatch

Tools invoked from inside a Code Mode program are dispatched **directly** against fresh Pi
built-in definitions. They intentionally bypass `tool_call`/`tool_result` middleware,
approval and preview extensions, registered tool overrides, and session-specific tool
operations. Nested Bash therefore uses Pi's default local implementation rather than a
configured prefix, shell hook, sandbox, remote operation, or other top-level override.

Bash can execute processes, use the inherited shell environment and network, and mutate
arbitrary paths. Read, edit, and write accept paths outside the project, including absolute
and home-relative paths. `code_mode` is an orchestration runtime, not a permission, process,
network, filesystem, or project-containment sandbox. MCP and arbitrary dynamic dispatch remain
separate. See ADR 0004.

## Availability policy

Code Mode is trusted-project-only. Availability is `projectTrusted && enabled`:

- In untrusted projects, no project-document filesystem I/O happens at all — the project
  settings document is neither read, stat'd, nor written — and a global `enabled: true`
  never grants availability.
- The `code_mode` tool registers at session start only when available. Disabling Code Mode
  mid-session stops executions immediately; enabling it takes effect at the next session
  start (`/reload`). Each slot input owns a publication flag that is revoked before deactivation,
  so a replaced session cannot publish from a late uninterruptible commit. Slot startup uses the
  shared interruptible best-effort host bootstrap for preview settings and returns no state
  snapshot. A preview host Promise that ignores cancellation detaches on interruption and cannot
  delay replacement. `onActivated` requires the current owner and token, rereads the live guarded
  state, then builds, wraps, registers, and activates the tool with repeated currency checks.
- Deactivating the `code_mode` tool from Pi's tool list is respected: the extension
  re-registers the tool each session but does not re-activate it against a deliberate
  deactivation. That intent also survives Pi recreating the extension on
  reload/new/resume/fork — it is bridged through a true-only process-memory handoff keyed
  **only** by the stable Pi session id captured at start, so a reloaded or resumed session keeps
  the tool off while a genuinely new session starts fresh. The application preserves closure
  intent only for the same stable key. A different or missing key resets active. There is no cwd
  fallback, so a different session in the same project cannot inherit the intent.

## Execution limits

Each execution applies the resolved settings exactly: `timeoutMs`, `maxToolCalls`, and
`maxOutputBytes` are enforced by the runtime (its truncation markers are reserved inside the
byte budget; returned JSON is pretty-printed only while the pretty form still fits
`maxOutputBytes`). The extension then applies one final code-point-safe UTF-8 clamp over the
entire model-visible text — success or thrown failure, including logs and diagnostic framing,
plus every early path (cancellation text, the `maxSourceBytes` refusal, unexpected runtime
errors) — so what the model receives never exceeds `maxOutputBytes` (zero → empty; a hostile
thrown string is bounded before it is ever surfaced). The one exception is the
stale or missing-state refusal, which can fire when no current configuration exists and is
therefore a short fixed bounded message. `maxSourceBytes` rejects oversized programs
(exact UTF-8 bytes) before execution; and
`maxCumulativeChildOutputBytes` bounds the cumulative UTF-8 bytes of successful nested tool
output and catchable nested failure text entering the program. An exact success fit is
admitted, the first success overrun is refused, failure text is truncated to the remaining
budget, and accounting stays exact under the interpreter's fixed nested concurrency of 8.
This is a post-settlement context/reliability bound: it cannot prevent or roll back a tool's
side effects. Nested results are plain text; image content is refused. Edit diff/patch details
and Bash result details are not passed into the guest, although Bash's text truncation notice
and temporary full-output path remain visible.

## `/code-mode-settings`

- `/code-mode-settings` — interactive editor in TUI mode (choose the scope, then edit values).
  Integer rows cycle their presets and offer a `custom…` entry that prompts for any integer
  inside the documented bounds. Pi has one editor slot, so choosing `custom…` returns a tagged
  `PromptInteger` result and closes the list before input opens. Scope selection, list settlement,
  custom input, application, and the fresh-snapshot reopen loop run as one outer session Effect
  submitted once. Cancelled, unavailable, and rejected custom input all reopen the list unless the
  session was interrupted, state disappeared, or the custom surface failed. Preset and `inherit`
  writes remain live against the current list's callback signal and roll back that row on failure.
  Each list iteration joins those nonrejecting write Promises after the list settles and before it
  handles close or custom input, reads fresh state, or reopens. The join stays interruptible.
  Every signal check uses one guarded getter that treats a throw as aborted, with no UI, store, or
  notification work. The custom boundary uses `Effect.ensuring` to abort callback authority and invoke Pi's available
  `done(Closed)` once; a normal `PromptInteger` result wins, and late factories get an inert
  component. Outside the interactive TUI the bare command never prompts:
  RPC hosts receive the help text as notifications, and in print/JSON modes (where
  notifications are not rendered) it resolves as a non-blocking no-op.
- `/code-mode-settings status` — effective values with per-field provenance
  (`default`/`global`/`project`) and the current availability.
- `/code-mode-settings [global|project] <id> <value>` — set one field. Integer fields accept
  any value inside the documented bounds. Scope defaults to `global`; `project` is accepted
  only in trusted projects.
- `/code-mode-settings [global|project] <id> inherit` — remove the field from that scope so it
  inherits (project → global → default).

## Configuration

Documents live at `~/.pi/agent/extensions/pi-code-mode.json` (global) and
`<project>/.pi/extensions/pi-code-mode.json` (trusted projects). Project fields override global
fields one field at a time; malformed fields fall back independently with path-only diagnostics.
Unrelated JSON fields are preserved on writes.

| Field                           | Default   | Bounds        |
| ------------------------------- | --------- | ------------- |
| `enabled`                       | `true`    | boolean       |
| `timeoutMs`                     | `30000`   | 1 – 600000    |
| `maxToolCalls`                  | `32`      | 0 – 10000     |
| `maxOutputBytes`                | `51200`   | 0 – 16777216  |
| `maxSourceBytes`                | `32768`   | 1 – 1048576   |
| `maxCumulativeChildOutputBytes` | `2097152` | 0 – 268435456 |
| `catalogBudget`                 | `2000`    | 0 – 100000    |
