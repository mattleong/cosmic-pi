# pi-herdr

Persistent read-only Claude Code, Pi, and Codex delegation for Pi through [Herdr](https://herdr.dev/).

## Install

```bash
pi install npm:pi-herdr
```

`pi-code-previews` ships as a dependency; no separate install is needed. Run `/reload` after installing into an active Pi session.

## Requirements

- Herdr 0.7.5 or newer with socket protocol 17 or newer.
- A running selected Herdr session and a `herdr` executable available on Pi's `PATH`.
- The selected agent executable installed and authenticated: `claude`, `pi`, or `codex`.
- Current Herdr integrations for every selected kind:

```bash
herdr integration install claude
herdr integration install pi
herdr integration install codex
```

`pi-herdr` never installs, starts, updates, or reconfigures Herdr or an agent CLI automatically. If extension preflight fails, the agent tools fail closed; fix the reported setup issue and run `/reload`. A missing kind-specific executable, authentication, or integration fails only that start request and rolls back its provisional pane.

## First run

1. Start Herdr and leave the selected session running.
2. Start Pi in the project and delegate an independent read-only research, review, or analysis task.
3. Select an explicit `kind` and native `model` for every requested agent.
4. The first agent creates a `pi-herdr · Agents` tab without taking focus. Later agents receive split panes in that tab.
5. Watch live state in the footer or use `/herdr` to inspect, guide, focus, or stop an agent.
6. Collect durable results with `herdr_agent_await`. Reported terminal panes close automatically while the managed tab stays reusable.

Example tool input:

```json
{
  "agents": [
    {
      "kind": "claude",
      "model": "opus",
      "name": "architecture-review",
      "task": "Review the architecture and return prioritized findings."
    },
    {
      "kind": "pi",
      "model": "openai-codex/gpt-5.6-sol",
      "name": "test-review",
      "task": "Review the test strategy and return missing cases."
    },
    {
      "kind": "codex",
      "model": "gpt-5.6-terra",
      "name": "security-review",
      "task": "Review security boundaries and return concrete risks."
    }
  ]
}
```

`kind` and `model` are required. Tool requests cannot provide executables, arbitrary argv, working directories, tool policies, approval modes, or harness configuration.

## Read-only harnesses

All three kinds are read-only, but the enforcement mechanism differs:

- **Claude Code** loads generated private settings containing only the installed Herdr session hook, an otherwise empty settings-source set, and the private report MCP. It receives only Read, Glob, Grep, WebFetch, WebSearch, and the report tool; Bash, mutation, notebook, and recursive-agent tools are denied with `permission-mode=dontAsk`.
- **Pi** starts with project trust disabled, normal extension/skill/prompt/theme discovery disabled, only the installed Herdr integration and bundled private reporter extension loaded, and only `read`, `grep`, `find`, `ls`, and `herdr_report_submit` active. Its session is stored privately inside the run directory.
- **Codex** starts with an isolated private `CODEX_HOME` that copies authentication but not user plugins, skills, MCP servers, or configuration. It uses the native read-only sandbox, approvals set to `never`, web/apps/plugins/multi-agent features disabled, one marker-validated Herdr session hook whose native trust review is bypassed only for that generated harness, and only the private report MCP server. Enterprise-managed Codex requirements can further restrict or reject these settings.

Claude and Pi are capability policies rather than complete operating-system sandboxes. Codex adds its native read-only filesystem sandbox, but its private MCP reporter intentionally operates outside that sandbox to write one bounded receipt.

## Behavior

- Claude Code, Pi, and Codex can share the same managed tab concurrently.
- The extension uses the configured Herdr session, otherwise the session inherited by Pi, otherwise Herdr's default session.
- It reuses one unambiguous workspace matching the Pi cwd. With no unambiguous match it creates an extension-owned workspace without taking focus.
- On the first agent start, it creates one owned tab named `pi-herdr · Agents` and launches the agent in that tab's root pane. Version-1 state is migrated to Claude records, and a fully revalidated legacy `pi-herdr · Claude` tab is renamed in place. Additional agents receive split panes, so there is no unused anchor while agents are present; `maxActive` bounds persistent active or inspectable agents.
- Kind is part of the persisted ownership tuple. A same-name agent of another kind is never adopted or destructively closed.
- After a durable `completed` or `failed` report, the agent pane closes automatically. An agent that settles without reporting is marked `failed` after a 15-second grace period and stays open for inspection.
- A `blocked` report is final: the run no longer accepts guidance and its pane stays open until stopped. A blocked run without a report can still receive guidance.
- The managed tab remains open, creating the replacement shell Herdr requires when the final reported agent closes.
- Automatic operations preserve the previously focused user tab. `/herdr` provides deliberate human focus and inspection.
- Agent processes and panes survive parent Pi session replacement or shutdown. Parent Pi owns only its monitor fibers and immutable projection.
- Final reports are private agent-directory state. Claude and Codex use the bounded stdio MCP helper; Pi uses a bundled tool that calls the same helper and receipt format.

## Agent tools

- `herdr_agent_start` — start one to twelve persistent read-only Claude, Pi, or Codex agents; every item requires `kind` and `model`.
- `herdr_agent_list` — page through managed runs for the current project, showing 25 rows by default.
- `herdr_agent_status` — inspect selected runs, including kind and model.
- `herdr_agent_await` — wait for reports or blocked attention.
- `herdr_agent_read` — read bounded terminal output for diagnostics.
- `herdr_agent_send` — send guidance to active runs.
- `herdr_agent_stop` — close validated extension-owned panes.

Every tool renders through the cooperative `pi-code-previews` shell.

## Human command

`/herdr` is a TUI-only manager for extension-owned agents. It surfaces kind, state, attention details, and final reports, and lets the user read terminal output, send guidance to resumable runs, focus the corresponding Herdr pane, or explicitly stop it.

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
  "maxActive": 24,
  "maxRetained": 100
}
```

`version: 1` is required; unknown keys are rejected. `pollIntervalMs` is clamped to 250–10,000 ms, `maxActive` to 1–100 active or inspectable runs, and `maxRetained` to 10–1,000 terminal runs. Project overrides are read only for trusted projects. Omit `session` to use the Herdr session inherited by Pi or the default session.

The TUI footer shows only live or blocked runs, so retained completion history does not leave a permanent status. Ownership, isolated harness files, private sessions, and reports are stored under `<agent-dir>/herdr/`; no project artifact is created.

## Security

- Read-only does not mean confidential. Delegated agents can read repository content and other files their process account and harness permit.
- Combining filesystem reads with network-capable model inference or tools can become an exfiltration channel when untrusted repository or web content prompt-injects the agent. Delegate on untrusted content deliberately.
- The Pi reporter extension and Claude/Codex report MCP helper are trusted host code with one fixed side effect: writing the run-bound private report receipt. They accept no path, command, URL, executable, model, or environment input from the agent.
- Agent tools cannot choose executable paths, arbitrary argv, sessions, cwd, or tool policy. Required model strings are validated, passed as one native CLI argument, and cannot begin with `-` or contain control characters.
- Project/user dynamic configuration is excluded from initial delegated Pi, Codex, and Claude harnesses. Each installed Herdr integration is marker-validated before its single session hook is copied or explicitly loaded.

### Native restore warning

Herdr's official integrations restore native sessions after a **Herdr server restart** with bare commands such as `claude --resume`, `pi --session`, and `codex resume`. Herdr 0.7.5 does not replay pi-herdr's fixed read-only flags, isolated configuration, or private report channel.

The user has explicitly opted into that restoration behavior. A natively restored agent is therefore **outside pi-herdr's read-only and durable-report guarantees** until it is stopped and relaunched through `herdr_agent_start`. Pi-herdr treats changed terminal ownership conservatively and will not destructively adopt the replacement pane.

## Current limits

- Herdr lifecycle state is screen-derived for Claude and Codex; Pi can additionally report lifecycle state through its installed Herdr integration. The private report receipt, not `idle` or `done`, is authoritative completion.
- Managed-resource mutation is coordinated between same-host Pi processes through a private agent-directory lock. A state-changing request may wait while another process completes startup; that wait is interruptible and bounded to two minutes. Distributed/network-filesystem coordination is out of scope.
- A force-killed or natively restored agent may not invoke the private report tool. The run remains diagnosable through `/herdr` and `herdr_agent_read` when its original pane ownership remains valid.
- Pi has no built-in web tool in the isolated harness. Claude retains its read/web tools; Codex web and broad app features are disabled.
- Herdr 0.7.3/protocol 16 uses an older agent automation surface and is intentionally rejected.
- Writer delegation, worktrees, and merge/apply workflows remain out of scope. Session-scoped Pi delegation belongs to `pi-subagents`; persistent Herdr delegation belongs here.
