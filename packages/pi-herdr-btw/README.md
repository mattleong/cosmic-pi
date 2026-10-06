# pi-herdr-btw

Opens a reusable "by the way" side session: a blank Pi session in its own [Herdr](https://herdr.dev/) pane beside your current one, for side questions that shouldn't clutter the main conversation.

## Features

- **One side session per parent**, reused across calls and reopened if its pane was closed.
- **Blank context:** the side session doesn't copy the parent transcript. It gets a read-only reference to the live parent session file and can read it when needed.
- **Prompt on open:** pass a question to send it straight to the side session.
- **Fresh start on demand** with `/herdr-btw new`.

## Install

This package is local-only. From the repository root:

```bash
pnpm install
pi install "$PWD/packages/pi-herdr-btw"
```

Then run `/reload`. It requires Pi running interactively inside a Herdr pane, Herdr protocol 17 or newer, a current Herdr Pi integration (`herdr integration install pi`), and a saved parent session.

## Usage

```text
/herdr-btw
/herdr-btw Explain the parent's latest design decision.
/herdr-btw new Start a separate side conversation.
```

Text after the command is the prompt. A first word of exactly `new` starts a fresh side session instead, so reword a prompt that happens to begin with "new".

Things to know:

- Old panes are never closed for you, and both sessions share the working directory, so either can edit project files.
- Side sessions live in the project's normal session directory, so `pi -c` may pick one. Use `/herdr-btw` to reopen them reliably.
- If a recorded side session is missing or doesn't match, the command refuses and asks you to use `/herdr-btw new`.

## How it works

On first use, the extension creates a blank Pi session with a preassigned ID, validates its file, and records a link in the parent session. Later calls focus the live pane, or relaunch the same session with `--session` in a new pane. The child receives the parent session ID, parent file, and its own ID as internal flags; before each run it rechecks them and opens the parent file read-only without following symlinks. The extension serializes its own commands but doesn't lock the side session against a Pi started by hand, and it never installs Herdr integrations or retries uncertain Herdr requests.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
