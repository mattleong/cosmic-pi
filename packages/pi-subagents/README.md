# pi-subagents

Background subagents for Pi on macOS and Linux. The main agent delegates work to profile-routed agents running on Pi, Claude Code, or Codex, keeps working, and gets their reports back automatically.

## Features

- **Seven profiles**, from fast read-only `scout`s to `worker`s that edit code, each routed to a model you choose.
- **Three local runtimes:** Pi, Claude Code, and Codex, with ordered fallback candidates per profile.
- **Background by default.** Reports and failures arrive automatically; the agent waits only when it needs a result.
- **Two-way supervision:** children can ask the parent questions and report progress; the parent can guide, interrupt, resume, retry, or stop them.
- **Nesting:** children can launch their own subagents, up to depth 3 with 12 direct children each by default.
- **Safe parallel writes:** per writer, either share the checkout under exact file claims fixed at launch, or work in an isolated worktree whose proposal the parent applies in one verified step (wholly or file by file), or reviews, tests, and applies as an exact prepared pair. Proposals can also be exported as a patch or branch, or revised onto the parent's current files.
- **Live view:** a run tree above the editor and the shared Activity manager, where you can also rename runs.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-subagents"
pi install "$PWD/packages/pi-cosmic-ui"   # recommended: shared Activity view
```

Requires Pi 1.2.0 or later. Claude Code routes need Claude Code 2.1.224 or later and Codex routes need Codex 0.145.0 or later, installed and signed in; an older CLI's routes are skipped in favor of the next candidate. Tested with Claude Code 2.1.259 through 2.1.300 and Codex 0.162.1; see [CLI versions](docs/local-backends.md#cli-versions) for how versions are checked. Pi routes need nothing extra.

## Usage

Ask for work that splits into independent pieces, and the agent launches subagents with `subagent_start`:

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

| Command               | Action                                                      |
| --------------------- | ----------------------------------------------------------- |
| `/subagents`          | Open the fleet in the Activity manager                      |
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

The agent's tools are `subagent_start`, `subagent_await`, `subagent_status` (which lists the run tree when called without run IDs), `subagent_send`, `subagent_reply`, `subagent_lifecycle`, `subagent_models`, and `subagent_workspace`. Native Pi codemode supports [read-only scripting](docs/native-codemode.md) with ordinary subagents; writer launches and recovery remain main-agent decisions.

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
            "host": "local",
            "runtime": "claude",
            "model": "opus",
            "effort": "high",
            "context": "fresh",
            "writeIntent": "read-only"
          },
          {
            "host": "local",
            "runtime": "pi",
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
  "delegation": "normal"
}
```

If a candidate is unavailable at launch, such as an unauthenticated CLI, the next one is tried. After a run has started, fallback happens only through an explicit `retry`.

## How it works

The root Pi session owns the coordinator: configuration, the run tree, backends, writer pools, and completion delivery; nested Pi sessions use authenticated proxy tools. Pi children talk over an RPC bridge, while Claude Code (stream-json) and Codex (app-server) report through a private loopback MCP supervisor. Writer leases are shared across Pi processes on the same machine. File claims coordinate writers but aren't a sandbox: a writer seen writing outside its claims is stopped alone, and the parent relaunches it with corrected claims. Claude and Codex runs use their native sandboxes. Stopping a run stops its subtree, and shutting down the root stops everything.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle, and the docs for detail:

- [Reference](docs/reference.md): delegation, worktree review and apply, and safety notes
- [Routing](docs/routing.md), [local backends](docs/local-backends.md), and [completion delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Native Pi codemode scripting](docs/native-codemode.md)
