# pi-subagents

Background subagents for Pi on macOS and Linux. The main agent delegates work to profile-routed agents running as local Pi processes, keeps working, and gets their reports back automatically.

## Features

- **Seven profiles**, from fast read-only `scout`s to `worker`s that edit code, each routed to a model you choose.
- **Custom agents** you define in `pi-subagents.json`: named roles with their own instructions, effort, and tool lists, routed through a profile.
- **Any model Pi can run**, Claude models included through a Pi provider, with ordered fallback candidates per profile.
- **Background by default.** Reports and failures arrive automatically; the agent waits only when it needs a result.
- **Two-way supervision:** children can ask the parent questions and report progress; the parent can answer or guide them, interrupt, resume, or stop them.
- **Agent messaging:** any agent in the session can list, message, and read any other, including the main agent.
- **Nesting:** children can launch their own subagents, up to depth 3 with 12 direct children each by default.
- **Safe parallel writes:** per writer, either share the checkout with other writers on disjoint task scopes, or work in an isolated worktree whose proposal the parent applies in one step, or reviews and tests before applying. Proposals can also be revised onto the parent's current files.
- **Live view:** a run tree above the editor and the shared Activity manager, where you can also rename runs.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-subagents"
pi install "$PWD/packages/pi-cosmic-ui"   # required for /subagents: shared Activity view
```

Requires Pi 1.4.0 or later. Subagents run on the installed Pi and its providers and need nothing extra.

## Usage

Ask for work that splits into independent pieces, and the agent launches subagents with `agent_start`:

```json
{
  "agents": [
    { "task": "Map the auth entry points, tests, and regression risks.", "profile": "scout" },
    { "task": "Review the auth changes for correctness and missing tests.", "profile": "reviewer" }
  ]
}
```

| Profile      | Context | Writes    | Effort        |
| ------------ | ------- | --------- | ------------- |
| `scout`      | fresh   | read-only | low           |
| `researcher` | fresh   | read-only | medium        |
| `planner`    | fresh   | read-only | xhigh         |
| `worker`     | fresh   | writer    | high          |
| `reviewer`   | fresh   | read-only | high          |
| `oracle`     | fork    | read-only | high          |
| `generalist` | fresh   | read-only | parent effort |

Read-only subagents don't get Pi's `edit` and `write` tools and are told not to change files, but `bash` and other inherited tools can still write. Read-only is cooperative, not a sandbox.

| Command               | Action                                                      |
| --------------------- | ----------------------------------------------------------- |
| `/subagents`          | Open subagents in the Activity manager                      |
| `/subagents profiles` | Choose models and fallbacks for each profile                |
| `/subagents settings` | Delegation, nesting limits, writer workspace                |
| `/subagents doctor`   | Check Pi, configuration, and each profile's route readiness |

### Delegation

`/subagents settings delegation <mode>` sets how much the main agent delegates:

| Mode            | Effect                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `normal`        | Default. The system prompt is unchanged.                                                       |
| `encouraged`    | The main agent prefers subagents and launches independent slices in parallel.                  |
| `orchestration` | The main agent acts as an orchestrator and delegates nearly all substantive work to subagents. |

The mode only changes prompt guidance; no tools are restricted, and subagents keep the default guidance. Session is the default scope. `global` and `project` persist for new sessions and apply after `/reload`. The footer shows the current profile set, marked `*` when this session has its own route edits, followed by the mode when it isn't `normal`.

### Tools

The main agent and Pi subagents share one `agent_*` family. `agent_start`, `agent_await`, `agent_lifecycle`, and `agent_worktree` act on agents you started and their descendants; `agent_list`, `agent_read`, and `agent_send` reach any agent in the session, the main agent and subagents at any depth:

| Tool              | Does                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start`     | Starts background subagents by profile or custom agent                                                                                              |
| `agent_await`     | Waits for runs you started and returns their reports, early when one asks you a question or another agent messages you                              |
| `agent_lifecycle` | Interrupts or stops runs you started                                                                                                                |
| `agent_worktree`  | Reviews, tests, applies, revises, or discards a worktree writer's proposal                                                                          |
| `agent_profiles`  | Shows each profile's route and the configured custom agents                                                                                         |
| `agent_list`      | Lists `main` and every subagent with its state, parent, role, model, worktree proposal, and whether it waits on its parent                          |
| `agent_read`      | Shows each run's status card and latest message or report, and main's latest message, without taking a report from its parent                       |
| `agent_send`      | Messages one agent now: answers a question from a run you supervise, guides a running agent, wakes an idle main agent, or resumes a finished Pi run |

Subagents also get `agent_contact_parent` to report progress, record a warning, or ask a blocking question. Native Pi codemode supports [read-only scripting](docs/native-codemode.md) with ordinary subagents; writer launches and recovery remain main-agent decisions.

### Agent messaging

Nothing is stored for later: each send reports what happened or why it was refused. A resumed run still reports to its own parent, naming who resumed it. Messages are peer requests, never user authority. Nothing caps how often agents message each other; press Esc to stop a loop. Details are in [Agent messages](docs/completion-delivery.md#agent-messages). To message other Pi sessions, use [pi-intercom](../pi-intercom/README.md).

## Configuration

Most people configure routes in `/subagents profiles`. Saved settings live in `~/.pi/agent/pi-subagents.json` and, for trusted projects, `.pi/pi-subagents.json`. Routes are grouped into named profile sets; a missing route inherits from the lower scope and then the built-ins.

```json
{
  "version": 6,
  "defaultProfileSet": "review",
  "profileSets": {
    "review": {
      "profiles": {
        "reviewer": [
          {
            "model": "claude-bridge/claude-opus-5-5",
            "effort": "high",
            "context": "fresh",
            "writeIntent": "read-only"
          },
          {
            "model": "openai-codex/gpt-5.6-sol",
            "effort": "high",
            "context": "fresh",
            "writeIntent": "read-only"
          }
        ]
      }
    }
  },
  "nesting": { "maxDirectChildren": 12, "maxDepth": 3 },
  "writerWorkspaceMode": "shared-checkout",
  "delegation": "normal",
  "hooks": {
    "WorktreeCreate": [{ "command": ["pnpm", "install", "--offline", "--frozen-lockfile"] }]
  }
}
```

If a candidate is unavailable at launch, such as a model whose provider isn't signed in, the next one is tried. A run whose startup fails before its task is issued, because Pi can't run that model or effort, moves to the next candidate in the same run and says so in a warning ([startup fallback](docs/routing.md#startup-fallback)). Once its task is issued, nothing falls back: a failed run names its route's next candidate, and the parent may start a new run with that model.

`hooks` mirror Claude Code's `WorktreeCreate` and `WorktreeRemove`, but run after the engine creates an isolated tree and before it removes one rather than replacing either. A `.worktreeinclude` file at the checkout's top level names ignored local files, such as `.env`, to copy into isolated trees. See [Worktree hooks](docs/local-backends.md#worktree-hooks) and [Included files](docs/local-backends.md#included-files).

Custom agents add named roles to the same files. Each one routes through a profile, replaces that profile's guidance with its instructions, and can pin effort, context, write intent, and the Pi tools its child inherits. Launch one with `"agent": "auth-reviewer"` instead of a profile. See [Custom agents](docs/routing.md#custom-agents).

```json
{
  "version": 6,
  "agents": {
    "auth-reviewer": {
      "description": "Reviews authentication changes against the threat model.",
      "instructions": "Review only authentication code. Cite file and line for every finding.",
      "profile": "reviewer",
      "effort": "xhigh",
      "tools": { "deny": ["bash"] }
    }
  }
}
```

When you ask for a specific model, the agent can set it on one launch with `"model": { "model": "claude-bridge/claude-opus-5-5" }`. The profile still sets the role, context, and write intent, but that launch tries only the named model: if it's unavailable the launch fails, and a failed run can't be retried onto another candidate. See [Per-launch model override](docs/routing.md#per-launch-model-override).

## How it works

The root Pi session owns the coordinator: configuration, the run tree, backends, writer pools, and completion delivery; nested Pi sessions use authenticated proxy tools. Pi children talk over an RPC bridge. Writer leases are shared across Pi processes on the same machine. Shared-checkout writers in one directory coordinate by task scope and aren't isolated from each other; worktree writers edit a private Git worktree whose changes the parent applies. No subagent runs in an OS sandbox: read-only children lack Pi's `edit` and `write` tools and are told not to change files, and they never hold a writer lease. Stopping a run stops its subtree, and shutting down the root stops everything.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle, and the docs for detail:

- [Reference](docs/reference.md): delegation, worktree review and apply, and safety notes
- [Routing](docs/routing.md), [local backends](docs/local-backends.md), and [completion delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Native Pi codemode scripting](docs/native-codemode.md)
