# pi-subagents

Background subagents for Pi. The main agent delegates work to profile-routed agents running on Pi, Claude Code, or Codex, keeps working, and gets their reports back automatically. Scripted workflows can coordinate many agents at once.

## Features

- **Seven profiles**, from fast read-only `scout`s to `worker`s that edit code, each routed to a model you choose.
- **Three local runtimes:** Pi, Claude Code, and Codex, with ordered fallback candidates per profile.
- **Background by default.** Reports and failures arrive automatically; the agent waits only when it needs a result.
- **Two-way supervision:** children can ask the parent questions and report progress; the parent can guide, interrupt, resume, rename, retry, or stop them.
- **Nesting:** children can launch their own subagents, up to depth 3 with 12 direct children each by default.
- **Safe parallel writes:** writers share the checkout under exact file claims, or opt into isolated worktrees that the parent reviews, tests, and integrates.
- **Scripted workflows:** `subagent_workflow` runs a JavaScript script that fans agents out with `agent()`, `parallel()`, and `pipeline()`.
- **Live view:** a run tree above the editor and the shared Activity manager.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-subagents"
pi install "$PWD/packages/pi-cosmic-ui"   # recommended: shared Activity view
```

Claude Code and Codex routes need those CLIs installed and signed in. Pi routes need nothing extra.

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

| Command               | Action                                                 |
| --------------------- | ------------------------------------------------------ |
| `/subagents`          | Open the fleet in the Activity manager                 |
| `/subagents profiles` | Choose models and fallbacks for each profile           |
| `/subagents settings` | Nesting limits, writer workspace mode, and `ultracode` |
| `/ultracode on\|off`  | Turn scripted workflows on or off for this session     |
| `/ultracode <task>`   | Run one request as a workflow                          |

The agent's tools are `subagent_start`, `subagent_await`, `subagent_status`, `subagent_list`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, `subagent_rename`, `subagent_models`, `subagent_claims`, `subagent_workspace`, and `subagent_workflow`. Workflows are opt-in: `subagent_workflow` is available only while `ultracode` is on or for a single `/ultracode` request.

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
  "ultracode": false
}
```

If a candidate is unavailable at launch, such as an unauthenticated CLI, the next one is tried. After a run has started, fallback happens only through an explicit `retry`.

## How it works

The root Pi session owns the coordinator: configuration, the run tree, backends, writer pools, and completion delivery. Nested Pi sessions use authenticated proxy tools instead of running their own. Pi children talk over an RPC bridge; Claude Code uses its stream-json protocol and Codex its app-server, both reporting through a private loopback MCP supervisor. Writer leases are keyed by directory identity and shared across Pi processes on the same machine. File claims coordinate writers but aren't a sandbox; Claude and Codex runs use their own native sandboxes. Stopping a run stops its subtree, and shutting down the root stops everything.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle, and the docs for detail:

- [Reference](docs/reference.md): full behavior, configuration, worktree review, and safety notes
- [Routing](docs/routing.md), [local backends](docs/local-backends.md), and [completion delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Workflows](docs/workflows.md), [workflow internals](docs/workflow-internals.md), and the [authoring guide](skills/workflow-authoring/SKILL.md)
