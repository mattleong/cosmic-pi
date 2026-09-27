# pi-herdr-btw

A private Pi extension that opens a reusable blank Pi side session in a user-owned pane in the current [Herdr](https://herdr.dev/) tab.

`BTW` names a separate side conversation. New side sessions do not use Pi's native `--fork`: they start without a copy of the parent transcript and receive a verified read-only reference to the live parent session file instead.

## Requirements

- Pi running interactively inside a Herdr-managed pane
- Herdr protocol 17 or newer
- A current Herdr Pi integration
- A persisted parent Pi session file

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
pi install "$PWD/packages/pi-herdr-btw"
```

Then run `/reload`.

If the former package was installed previously, remove its source shown by `pi list` before installing this package.

## Usage

```text
/herdr-btw
/herdr-btw Explain the parent's latest design decision.
/herdr-btw-new Start a separate side conversation.
```

`/herdr-btw` keeps one reusable side session per parent Pi session:

1. On first use, it creates a blank Pi session with a preassigned session ID, validates the resulting session file, and records a reusable link in the parent session.
2. If that child Pi is still running, it validates the linked file and exact live Herdr identity, then focuses the existing pane and delivers the optional question.
3. If the pane was closed or Pi exited, it validates the child file and reopens the same session with `--session` in a new sibling pane.

`/herdr-btw-new` always creates a fresh blank side session. The new link becomes authoritative after startup and child-file validation. A later prompt or focus failure does not discard a child that already started successfully. The command never closes the previous user-owned pane.

If a recorded link or child file is missing, malformed, replaced, or ambiguous, `/herdr-btw` fails closed and asks you to use `/herdr-btw-new`.

## Live parent reference

Each child launch receives three fixed internal extension flags:

- the parent session ID
- the parent session file
- the child session ID that owns the reference

At child activation and before every child agent run, the extension checks that the child ID still matches and probes the parent header through a bounded read-only no-follow file descriptor. The child system prompt then identifies the live parent JSONL file and tells the agent to use normal read-only `read` or `bash` tools when current parent activity matters.

The extension does not import parent messages, poll the parent, register a parent-reading tool, or send child answers back automatically. If normal file tools are disabled, the child still knows the reference but cannot inspect it.

## Safety and ownership

The extension serializes its own BTW commands and checks Herdr once when selecting reuse and again immediately before a resume launch. This prevents duplicate launches observed through the same extension workflow. It does not lock the child session against a separate Pi process started manually or outside Herdr. Do not manually open the linked child session while `/herdr-btw` is resuming it.

Side-session files share the project's normal Pi session directory. As a result, `pi -c` may choose a recently active side session. Use `/herdr-btw` for deterministic side-session reopening. If agent startup fails after the blank child file is reserved, an unlinked blank session may remain in `/resume` and can be deleted there.

Every successful pane belongs to the user. Parent reload, shutdown, and `/herdr-btw-new` do not close old panes. Both Pi sessions share the same working directory, so either can modify project files concurrently.

Prompt text is passed as one Herdr argument with a fixed non-flag prefix. No model or shell interprets it on the parent side. Mutating Herdr requests with uncertain outcomes are not retried or cleaned up destructively.

## Development

```bash
pnpm --filter pi-herdr-btw test
pnpm --filter pi-herdr-btw validate
```
