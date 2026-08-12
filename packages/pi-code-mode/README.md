# pi-code-mode

Code Mode for pi: one `code_mode` agent tool that runs a confined, interpreted JavaScript
program orchestrating read-only Pi tools (`tools.pi.read`, `tools.pi.grep`, `tools.pi.find`,
`tools.pi.ls`) in a single tool call, with trusted-project-only scoped settings.

The program is TypeScript-transpiled, Acorn-parsed, and executed by a vendored tree-walk
interpreter (OpenCode 2 Code Mode; see ADR 0003) — never `eval`, `Function`, `node:vm`, or a
child process. Programs have no filesystem, network, process, module, or timer authority of
their own; they can only call the four read-only guest tools and the runtime's own
`tools.$codemode.search` discovery tool. The interpreter lives in the private
`pi-code-mode-runtime` workspace package nested at `runtime/` inside this package; its built
output ships inside this package.

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
falling back to a neutral phrase. While the program runs, nested calls appear as bounded
activity rows derived from their inputs (`… Search TODO in src`, `✓ Read src/app.ts`,
`✗ List missing/`), followed by a muted status footer (`4 operations completed`,
`2 of 4 completed`, `Cancelled`, `Failed`; `+N more` beyond 32 rows). Expanding the call
shows the full program source; expanding the result shows the complete model-visible output
or error, and the collapsed hint names the configured `app.tools.expand` key when one is
bound (`▸ output · ctrl+o expand`). All displayed text is sanitized against terminal
control injection, and
presentation never changes the model-visible result, details, or any execution limit.

## Known limitation: nested calls bypass Pi middleware

Tools invoked from inside a Code Mode program are dispatched **directly** against Pi's
built-in read/grep/find/ls implementations. They bypass Pi extension middleware that observes
or wraps top-level tool calls (tool_call events, approval wrappers, preview shells, other
extensions' overrides), and their filesystem authority matches the direct Pi tools —
**including absolute paths outside the project**. `code_mode` does not confine reads to the
project directory; the tool description states this to the model. This is why the catalog is
read-only: bash, edit, write, MCP, and arbitrary dispatch stay excluded until a canonical
nested-tool dispatcher exists (ADR 0003).

## Availability policy

Code Mode is trusted-project-only. Availability is `projectTrusted && enabled`:

- In untrusted projects, no project-document filesystem I/O happens at all — the project
  settings document is neither read, stat'd, nor written — and a global `enabled: true`
  never grants availability.
- The `code_mode` tool registers at session start only when available. Disabling Code Mode
  mid-session stops executions immediately; enabling it takes effect at the next session
  start (`/reload`).
- Deactivating the `code_mode` tool from Pi's tool list is respected: the extension
  re-registers the tool each session but does not re-activate it against a deliberate
  deactivation. That intent also survives Pi recreating the extension on
  reload/new/resume/fork — it is bridged through a process-memory handoff keyed **only** by
  the stable Pi session id, so a reloaded or resumed session keeps the tool off while a
  genuinely new session starts fresh. When no session id is exposed nothing is preserved and
  the tool starts activated (there is deliberately no cwd fallback, so a different session
  in the same project can never inherit the intent).

## Execution limits

Each execution applies the resolved settings exactly: `timeoutMs`, `maxToolCalls`, and
`maxOutputBytes` are enforced by the runtime (its truncation markers are reserved inside the
byte budget; returned JSON is pretty-printed only while the pretty form still fits
`maxOutputBytes`). The extension then applies one final code-point-safe UTF-8 clamp over the
entire model-visible text — success or thrown failure, including logs and diagnostic framing,
plus every early path (cancellation text, the `maxSourceBytes` refusal, unexpected runtime
errors) — so what the model receives never exceeds `maxOutputBytes` (zero → empty; a hostile
thrown string is bounded before it is ever surfaced). The one exception is the
stale/unavailable refusal, which can fire when no current configuration exists and is
therefore a short fixed bounded message. `maxSourceBytes` rejects oversized programs
(exact UTF-8 bytes) before execution; and
`maxCumulativeChildOutputBytes` bounds the cumulative UTF-8 bytes of nested tool output
entering the program — an exact fit is admitted, the first overrun is refused with a
model-safe message, and accounting stays exact under the interpreter's fixed nested
concurrency of 8. Nested results are plain text; image content is refused.

## `/code-mode-settings`

- `/code-mode-settings` — interactive editor in TUI mode (choose the scope, then edit values).
  Integer rows cycle their presets and offer a `custom…` entry that prompts for any integer
  inside the documented bounds. Outside the interactive TUI the bare command never prompts:
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
