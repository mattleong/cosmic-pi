# pi-directory-models

Remembers the provider, model, and thinking level you use in each working directory, and restores them when you start a new Pi session there.

## Features

- **Per-directory preferences** restored for fresh sessions and `/new`.
- **Automatic updates** whenever you change model or thinking level with `/model`, model cycling, or the thinking-level controls.
- **One-off overrides:** `--model` or `--thinking` on the command line skips restoring for that session and isn't saved.
- **Symlink-aware:** aliases of the same directory share one preference.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-directory-models"
```

## Usage

There are no commands. Pick a model in a directory once and later fresh sessions there start with it. Resumed, forked, and reloaded sessions keep their own model. A directory without a preference records Pi's current model on its first fresh session.

## Configuration

Preferences are private global data, one file per directory:

```text
~/.pi/agent/pi-directory-models/<directory>--<short-hash>.json
```

```json
{
  "version": 1,
  "cwd": "/Users/example/work/cern",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "thinkingLevel": "high"
}
```

You can edit these by hand; valid changes apply to the next fresh session. `cwd` is the exact canonical path, and the hash tells apart directories with the same name.

## How it works

The extension resolves the canonical current directory at session start and, for fresh sessions, applies its saved preference through Pi's `setModel()`. That changes only the current session, never Pi's global default. Failures fail open: an invalid record, an unavailable model, missing authentication, or a write error leaves Pi's current model in place with a short warning. A saved model that's temporarily unavailable is kept rather than overwritten.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
