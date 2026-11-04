# pi-rex-btw

Opens "by the way" side conversations: each `/btw` starts a fresh Pi in a new [Rex](https://www.superlogical.com/rex/) pane, so side questions don't clutter the main conversation or each other.

## Features

- **A clean context every time.** Each pane is its own blank conversation; open as many as you like.
- **Sees the live parent.** The side session has a read-only `parent_conversation` tool that reads the parent's latest messages, and calls it again whenever a question depends on what the parent is doing. Nothing is copied in automatically, and nothing goes back.
- **Same model.** The side session starts with the parent's current model and thinking level.
- **Stays out of your way.** The first pane splits yours; later ones stack beside the newest BTW pane that's still open.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-rex-btw"
```

Then run `/reload`. It requires Pi running interactively inside a Rex pane.

## Usage

```text
/btw
/btw What does the parent's latest test failure mean?
```

Text after the command becomes the side session's first message. The side pane opens with a one-line note saying it can read the parent session, and its reads show as `parent_conversation last 15 messages`; expand one to see the messages it read.

Things to know:

- Side sessions aren't saved. Closing a pane discards its conversation.
- The side session can only see the parent once the parent has saved its session, which Pi does once you send its first message.
- Both sessions share the working directory, so either can edit project files.
- The first message is passed as a command-line argument, so other local processes can read it with `ps` while that Pi runs.
- Panes are never closed for you. If Rex can't confirm whether a pane opened, the command reports it instead of trying again.

## How it works

`/btw` runs `rex split` beside the anchor pane. When your shell is a POSIX shell such as zsh or bash, Pi starts through an interactive shell so the environment from your shell configuration, such as API keys, is available. The child gets `--no-session`, the parent's model, and internal flags marking it as a side session and naming the parent session; it also loads this package explicitly so it understands those flags. Only a child with a parent gets the `parent_conversation` tool, which reads the end of the parent's session file and follows its current branch back, by default through the last 15 messages and at most 50. Before each run, the child checks that the parent file still exists and adds a short note to its system prompt pointing at the tool.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
