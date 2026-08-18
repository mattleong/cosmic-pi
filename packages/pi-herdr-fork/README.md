# pi-herdr-fork

A private Pi extension that adds a deterministic `/herdr-fork` command. The command forks the current Pi session into a new user-owned pane in the current [Herdr](https://herdr.dev/) tab.

## Requirements

- Pi running interactively inside a Herdr-managed pane
- Herdr protocol 17 or newer
- A current Herdr Pi integration
- A persisted Pi session file

Check or update the integration manually:

```bash
herdr integration status
herdr integration install pi
```

The extension never installs or updates Herdr integrations itself.

## Install

From this repository root:

```bash
pnpm install
pi install "$PWD/packages/pi-herdr-fork"
```

Then run `/reload`.

## Usage

```text
/herdr-fork
/herdr-fork Review the current plan from a fresh branch.
```

The command:

1. finds the calling Pi pane rather than another client's focused pane;
2. creates a sibling pane in the same tab;
3. waits for sustained shell readiness through bounded read-only inspection;
4. starts a native Pi fork from the current session file;
5. validates Herdr's atomic pane, terminal, and agent startup evidence;
6. optionally submits the supplied text as an initial request; and
7. focuses the new fork.

Prompt text is received directly by the Pi command and passed as one Herdr argument with a fixed non-flag prefix. No model or shell interprets it on the parent side.

## Ownership

After successful startup, the pane belongs to the user. The extension retains no pane state, does not close the pane on parent reload or shutdown, and does not adopt it later. Exit Pi or close the pane through Herdr when finished.

The child receives a point-in-time copy of the parent conversation. It does not receive later parent conversation updates. Both sessions share the same working directory, so file changes are live and concurrent; either Pi can modify the project.

If a mutating Herdr request has an uncertain result, the command does not retry or destructively clean up. It reports the pane identifier when one is known so the user can inspect it.

## Development

```bash
pnpm --filter pi-herdr-fork test
pnpm --filter pi-herdr-fork validate
```
