# pi-herdr

Persistent read-only Claude Code delegation for Pi through [Herdr](https://herdr.dev/).

## Requirements

- Herdr 0.7.5 or newer with socket protocol 17 or newer.
- A running selected Herdr session.
- Claude Code installed and authenticated.
- The current Herdr Claude integration for native session restoration.

`pi-herdr` never installs, starts, updates, or reconfigures Herdr or Claude automatically. If preflight fails, fix the reported setup issue and run `/reload`.

## Behavior

- Claude Code only in the MVP.
- Project access is read-only: Claude receives Read, Glob, Grep, WebFetch, WebSearch, and one private final-report MCP tool. Bash, Edit, Write, notebook mutation, and recursive agent tools are denied.
- The extension uses the configured Herdr session, otherwise the session inherited by Pi, otherwise Herdr's default session.
- It reuses one unambiguous workspace matching the Pi cwd. With no unambiguous match it creates an extension-owned workspace without taking focus.
- On the first agent start, it creates one owned tab named `pi-herdr · Claude` and launches Claude in that tab's root pane. Additional agents receive split panes, so there is no unused anchor while agents are present and no extension pane-count limit. After a durable completed or failed report, the agent pane closes automatically; a missing-report failure stays open for inspection. The managed tab remains open, creating the replacement shell Herdr requires when the final reported agent closes.
- Automatic operations preserve the previously focused user tab. `/herdr` provides deliberate human focus and inspection.
- Claude processes and panes survive Pi session replacement or shutdown. Pi only owns its monitor fibers and immutable projection.
- Final reports are submitted through a private per-run stdio MCP helper into the Pi agent directory. Users never manage report files.

## Agent tools

- `herdr_agent_start` — start one to twelve persistent read-only Claude agents.
- `herdr_agent_list` — list managed runs for the current project.
- `herdr_agent_status` — inspect selected runs.
- `herdr_agent_await` — wait for reports or blocked attention.
- `herdr_agent_read` — read bounded terminal output for diagnostics.
- `herdr_agent_send` — send guidance to active runs.
- `herdr_agent_stop` — close validated extension-owned panes.

Every tool renders through the cooperative `pi-code-previews` shell.

## Human command

`/herdr` lists extension-owned Claude runs and lets the user read output or reports, focus the corresponding Herdr pane, or explicitly stop it.

## Configuration

Global configuration: `<agent-dir>/extensions/pi-herdr.json`.

Trusted project override: `<cwd>/<CONFIG_DIR_NAME>/extensions/pi-herdr.json` (`CONFIG_DIR_NAME` is normally `.pi`).

```json
{
  "version": 1,
  "enabled": true,
  "session": "work",
  "pollIntervalMs": 1000,
  "showFooterStatus": true,
  "maxRetained": 100
}
```

Omit `session` to use the Herdr session inherited by Pi or the default session. Ownership and report state are stored privately under `<agent-dir>/herdr/`; no project artifact is created.

## Current limits

- Read-only is a Claude tool policy, not an operating-system sandbox.
- Herdr lifecycle state is screen-derived for Claude Code. The private report receipt, not `idle` or `done`, is authoritative completion.
- Managed-resource mutation is coordinated between same-host Pi processes through a private agent-directory lock. A state-changing request may wait while another Pi process completes a Herdr/Claude startup sequence; that wait is interruptible and bounded to two minutes. Coordination assumes a shared local filesystem and same-host PID liveness; distributed/network-filesystem coordination is out of scope.
- A force-killed Claude process may not invoke the report tool. The run remains diagnosable through `/herdr` and `herdr_agent_read`.
- Herdr 0.7.3/protocol 16 uses an older agent automation surface and is intentionally rejected.
- Writer delegation, worktrees, and merge/apply workflows remain out of scope. Persistent Claude delegation belongs to this package; `pi-subagents` is Pi-only.
