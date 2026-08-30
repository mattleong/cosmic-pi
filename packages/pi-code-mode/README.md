# pi-code-mode

Code Mode for pi: one `code_mode` agent tool that runs a confined, interpreted JavaScript
program orchestrating seven core Pi built-ins (`tools.pi.read`, `tools.pi.bash`,
`tools.pi.edit`, `tools.pi.write`, `tools.pi.grep`, `tools.pi.find`, `tools.pi.ls`), native
`tools.pi.powershell` on Windows, and the explicit `tools.session.backgroundTask` adapter in a
single tool call, with trusted-project-only scoped settings.

The program is TypeScript-transpiled, Acorn-parsed, and executed by a vendored tree-walk
interpreter (OpenCode 2 Code Mode; see ADR 0003) — never `eval`, `Function`, `node:vm`, or a
child JavaScript process. The interpreter provides no ambient filesystem, network, process,
environment, module, or timer APIs; programs can only call the supplied tool tree and the
runtime's own `tools.$codemode.search` discovery tool. Supplied shell, edit, write, and
background-task start operations intentionally confer full local-user process, network,
environment, and unrestricted filesystem authority (ADRs 0004 and 0006). The interpreter lives in the private
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

In the TUI a `code_mode` call renders compactly as `Code Mode · <intent>`. The optional
`intent` parameter is a short human-readable purpose, with a neutral fallback. Execution starts
with `Starting…`, then shows bounded activity rows derived from nested inputs. Rows reuse built-in
tool icons and show queued, running, succeeded, failed, or cancelled status plus settled duration.

Beyond 32 rows, visible slots prioritize active, failed, cancelled, and recent calls under a
`+N earlier` marker. Exact counts still include hidden calls. Expanding the call shows the program
source, while expanding the result shows the model-visible output or error. Successful objects
with top-level string fields and at least one multiline value render as labeled sections rather
than escaped JSON. Collapsed hints use the configured `app.tools.expand` keys. All displayed text
is sanitized against terminal control injection. Presentation does not change model-visible
results or execution limits.

## Supplied tool authority and direct nested dispatch

Tools invoked from inside a Code Mode program are dispatched **directly** against fresh Pi
built-in definitions. They intentionally bypass `tool_call`/`tool_result` middleware,
approval and preview extensions, registered tool overrides, and session-specific tool
operations. Nested Bash and PowerShell therefore use Pi's default local implementations rather
than configured prefixes, shell hooks, sandboxes, remote operations, or other top-level
overrides. PowerShell is present only on Windows.

Enabling Code Mode means accepting the program authored by the agent as the authorization for
its nested operations. Do not rely on Pi middleware, approval prompts, registered overrides, or
claim observers to inspect or stop those operations. Enforce any required restriction outside
Code Mode, or disable the tool.

Shell tools can execute processes, use the inherited environment and network, and mutate
arbitrary paths. Read, edit, and write accept paths outside the project, including absolute
and home-relative paths. `code_mode` is an orchestration runtime, not a permission, process,
network, filesystem, or project-containment sandbox. MCP and arbitrary dynamic dispatch remain
separate. See ADR 0004.

`tools.session.backgroundTask` is one reviewed adapter, not registered-tool dispatch. It queries
a versioned `pi-background-task` capability for the same stable Pi session on each invocation.
The provider must be loaded, current, and active. A started task may outlive the Code Mode call;
Background Tasks owns it and terminates it at Pi session shutdown. Deactivating the top-level
`background_task` tool also makes the nested adapter unavailable. See ADR 0006.

## Availability policy

Code Mode is trusted-project-only. Availability is `projectTrusted && enabled`:

- In untrusted projects, no project-document filesystem I/O happens at all — the project
  settings document is neither read, stat'd, nor written — and a global `enabled: true`
  never grants availability.
- The `code_mode` tool registers at session start only when available. Disabling Code Mode
  mid-session stops executions immediately; enabling it takes effect at the next session start
  (`/reload`).
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
side effects. Pi built-in results are plain text; image content is refused. Edit diff/patch
details and shell result details are not passed into the guest, although shell truncation notices
and temporary full-output paths remain visible. Background Tasks returns copied structured data.
The provider bounds text and estimates JSON size against the current remaining allowance before
copying snapshots; the consumer repeats that aggregate check before charging compact JSON to the
same cumulative budget.

## `/code-mode-settings`

- `/code-mode-settings` opens the interactive TUI editor. Choose a scope, then edit values.
  Integer rows cycle through presets and include a `custom…` prompt for any value inside the
  documented bounds. Outside the interactive TUI, the bare command never prompts. RPC hosts
  receive help through notifications; print and JSON modes resolve without blocking.
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
