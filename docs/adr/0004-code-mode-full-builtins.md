# ADR 0004: Code Mode exposes all Pi built-ins

- Status: Accepted
- Date: 2026-08-12
- Supersedes in part: ADR 0003, "The integration is read-only, and nested dispatch is a prerequisite for more"

## Context

ADR 0003 introduced a fixed read-only Code Mode catalog because nested calls execute Pi tool
definitions directly instead of entering Pi's top-level tool middleware. That choice treated a
future middleware-preserving nested dispatcher as a prerequisite for shell and mutation tools.

Pi itself is a trusted coding agent and does not provide an inherent approval policy. Approval,
preview, sandbox, remote-operation, and path-protection behavior may be added by extensions or by
registered tool overrides, but `pi-code-mode` does not own those systems. Making this extension's
built-in catalog depend on hypothetical middleware compatibility would leave Code Mode less capable
than Pi's normal built-in tool surface without providing a security boundary users can rely on.

## Decision

`pi-code-mode` exposes all seven Pi built-ins through one explicit guest namespace:

- `tools.pi.read`
- `tools.pi.bash`
- `tools.pi.edit`
- `tools.pi.write`
- `tools.pi.grep`
- `tools.pi.find`
- `tools.pi.ls`

The extension continues to instantiate fresh Pi built-in definitions and dispatch them directly.
This is an intentional product contract, not an emulation of top-level dispatch. Nested calls do
not run `tool_call`/`tool_result` middleware, approval or preview extensions, registered tool
overrides, or session-specific operations. Nested Bash therefore uses Pi's default local Bash
implementation rather than a configured prefix, shell hook, sandbox, remote implementation, or
other top-level override. MCP and arbitrary dynamic tool dispatch remain outside this package.

### Confinement and authority

The vendored runtime still confines the generated JavaScript language: it provides no ambient
Node filesystem, network, process, environment, module, timer, `eval`, `Function`, or `node:vm`
API. Programs can invoke only the supplied tool tree.

The supplied tool tree now intentionally grants full local-user authority. Bash can execute
processes, access the inherited shell environment and network, and mutate arbitrary paths. Edit and
write accept relative, absolute, and home-relative paths. Code Mode is therefore an orchestration
runtime, not a filesystem, process, network, permission, or project-containment sandbox.

Project trust and the `enabled` setting remain availability gates. They do not reduce the authority
of an execution once admitted.

### Operational semantics

Pi's built-ins remain the operational owners:

- Bash supports an optional per-command timeout, reacts to outer cancellation, tracks its child
  PID, and attempts process-tree termination. Its visible output is a 2,000-line/50-KiB tail; larger
  full output is persisted to an unbounded temporary log whose path appears in the result. A fully
  daemonized descendant may escape process-group cleanup.
- Edit and write share Pi's in-process same-file mutation queue. Different files may mutate in
  parallel, reads do not join the queue, writes are non-atomic, and cancellation cannot roll back an
  already applied mutation.
- Canonical Code Mode edit input is a non-empty `edits[]` array. Pi's top-level legacy
  `prepareArguments` compatibility is not reproduced.
- Nested results remain plain text. Image content is refused; edit diff/patch details and Bash
  result details do not enter the guest program.

Existing Code Mode source, time, call-count, result, and cumulative child-output limits remain
reliability and context controls. They do not prevent or undo side effects. Successful nested output
and catchable nested failure text are charged to the same cumulative UTF-8 budget after the child
operation settles.

## Consequences

- Code Mode can perform complete multi-step coding workflows in one program using the same seven
  built-in capability categories available to Pi.
- Users and extensions must not assume that top-level middleware, approvals, previews, overrides,
  or remote/sandbox operations apply to nested Code Mode calls.
- The outer extension-owned `code_mode` tool still renders through `pi-code-previews`; nested edit
  and write calls do not receive independent preview shells or before-write correlation.
- Documentation must always pair interpreter-confinement claims with the authority supplied by
  Bash, edit, and write.
- ADR 0003 remains authoritative for the vendored runtime, two-package shipping layout, runtime
  provenance, and in-process confinement. Only its read-only integration policy is superseded.

## Primary references

- ADR 0003: Vendored Code Mode runtime and two-package architecture
- `packages/pi-code-mode/ARCHITECTURE.md`
- `packages/pi-code-mode/src/boundary/host-builtin-tools.ts`
- `packages/pi-code-mode/src/tools/catalog.ts`
