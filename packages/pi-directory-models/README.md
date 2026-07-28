# pi-directory-models

A small Pi extension that remembers the selected provider, model, and thinking level for each working directory.

## Install

```bash
pi install npm:pi-directory-models
```

## Behavior

- Fresh sessions restore the preference for the canonical current directory.
- `/new` restores the directory preference.
- Resumed, forked, and reloaded sessions keep their session model.
- An explicit `--model` is a one-off override and is not saved.
- `/model`, model cycling, and thinking-level changes update the preference.
- Symlink aliases of the same directory share a preference.

When a directory has no preference, its first ordinary fresh session records Pi's current model and thinking level.

## Storage and manual editing

Preferences are private global Pi data, not project files:

```text
~/.pi/agent/pi-directory-models/<directory>--<short-hash>.json
```

For example:

```text
~/.pi/agent/pi-directory-models/cern--7f3a91c2d481.json
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

The readable directory name helps locate the record, the short hash disambiguates directories with the same basename, and `cwd` confirms the exact canonical path. Valid manual edits are read on the next fresh session.

Invalid records, unavailable models, missing authentication, and persistence failures fail open: Pi keeps its current model and shows a bounded warning. An unavailable saved model is retained so a temporary auth or catalog issue does not erase the preference.

## Pi global default

Pi's public `setModel()` API also updates Pi's global default. This extension cannot suppress that internal write, but remembered directories restore their own preference instead of relying on the shared global value.
