# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md). `config/store.ts` is the only persistence door; every mutation is an optimistic exact-document write that preserves unrelated sets and routes and rechecks project trust.

## Current Session

`/subagents profiles` always opens Current Session, the only active working set.

- At session start it is a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Edits change later launches and `subagent_models` immediately; active runs keep the route captured at launch.
- Applying a saved set resolves all seven profiles, rejects any invalid route, previews the replacement, and commits it with one expected session revision, clearing earlier per-profile changes. It never changes a Project or Global document.
- Current Session writes no project, global, or Pi session-history data. It survives `/tree` and `/reload` through the bounded application handoff and clears on `/new`, `/resume`, `/fork`, quit, or restart.
- If `/reload` can't decode the session's handoff, subagents stay inactive rather than inheriting a different route. Start a fresh session to recover.

## Profile editor

One dashboard holds Current Session and Saved profiles tabs, each remembering its position. Editors keep the selected profile, candidate, field, and Advanced expansion during internal navigation. The dashboard keeps editors and dialogs in one custom host lifetime, opened on Cosmic UI's shared `screen` surface.

- Candidate sections are labelled Primary and Fallback N. Main fields are Model, Reasoning, File access, and Run with (local Pi, Claude, or Codex only); Advanced holds Context and OpenAI fast mode where applicable.
- Each section's Manage menu has Duplicate, valid Move up/Move down, and Delete. Delete confirms and warns when it would disable the profile; there is no standalone Disable.
- Add fallback and Undo changes appear under the profile name; disabled profiles show Add model instead.
- Save these profiles as a set, below the profile list, captures all seven profiles.

Keys:

- Up/k and Down/j move without writing; Right/l focuses fields and Left/h the profile list; Enter opens the selected editor or picker.
- Tab and Shift+Tab switch tabs; Esc closes the nearest picker or backs up one level; `?` opens help.
- `m`, `e`, and `r` open Model, Reasoning, and Run with. `a` opens the candidate's Manage menu, and `+` adds a fallback after a model is chosen.
- `[` and `]` move between candidates, `/` searches profiles, and `s` opens the save dialog.
- `/subagents profiles worker` opens a profile directly.

Behavior:

- A runtime change that needs a model commits both together. Pickers distinguish profile-default reasoning from a pinned level and keep unavailable configured models on cancellation, which is silent and changes nothing.
- Edits auto-save serially. Conflicts refresh without retrying, and a failed refresh blocks edits until reopening. Catalog cancellation, disposal, and activation replacement suppress late continuations.

### Undo during an editor visit

- `●` marks this visit's own changes that Undo can restore, not a persistent override or unsaved edit.
- Undo restores the selected profile's opening declaration in Current Session or a saved set, preserving absence, disabled state, optional fields, and order. It never resets Current Session to its saved default.
- Checkpoints survive tab switches, pickers, and forms, but not closing the dashboard. Renaming a set carries its checkpoint, deleting drops it, and a confirmed Use resets the session checkpoint.
- Undo uses checked writes and committed receipts. An external change to the same route withdraws Undo ownership rather than overwriting it, and unrestorable invalid declarations fail safely.

## Native model discovery

- Switching a candidate to Claude or Codex opens that runtime's live-catalog picker, which offers only advertised models and commits runtime and model together. Neither runtime has a built-in model.
- The Claude picker asks the installed CLI for its catalog without inference. Before each lookup it reads only the validated `model` field of `$HOME/.claude/settings.json` (regular files up to 64 KiB, following that path's symlink for dotfile managers). `CLAUDE_CONFIG_DIR` and project settings are not consulted; missing settings use `default`.
- With a preference set, discovery combines the default and preferred-selector catalogs, and both probes must succeed. Aliases and context suffixes such as `[1m]` stay separate choices, and an alias target the CLI doesn't list gains its own row.
- The selector is part of the cache key, keyed by cwd, so changing the preference updates discovery on the next access without reload.
- Each probe has a 10-second deadline and confirmed process cleanup, with settings sources disabled, hooks disabled, and empty strict MCP. Discovery never changes launch policy.
- Catalog refresh belongs to the editor's activation and cancellation scope. Success atomically replaces the immutable root Pi-model snapshot; failure keeps the prior generation, and each picker captures one generation.

## Saved-set library

The Saved profiles tab groups sets by Project and Global. Untrusted Project rows stay visible but unavailable, without reading their configuration. Selecting a set previews its seven resolved profiles, including inherited, disabled, and invalid routes.

- Enter edits, `u` opens Use, `a` opens More (Make/clear default, Copy, Rename, Delete), and Esc closes the library.
- Use previews and confirms before replacing Current Session. Opening or editing a set never applies it or makes it a default.
- A saved editor reads `Editing name · session not affected`. Its edits change only that value, and making a set default affects new sessions only, so no reload is requested.
- Clearing the Project default falls back to Global; clearing Global falls back to built-ins. A selected default can't be deleted until it is replaced or cleared.
- Invalid sets stay visible and can't be used or made default. Project-set status includes routes inherited from the selected Global set. Route-invalid sets remain editable; structurally invalid sets must be deleted and recreated; a malformed unnamed default appears as a clearable repair row.
- Saving is available only from Current Session. The dialog takes a name and a destination (Project by default when trusted, otherwise Global). One store action writes all seven effective routes, and refuses fail-closed routes. The profile service holds its revision lock through the transaction, so an interleaved session edit either commits first and rejects the save, or waits.

## Delegation settings

`/subagents settings` edits the delegation mode in Session, Global, or trusted Project scope with the same precedence and timing as nesting.

- `normal` leaves the system prompt unchanged. `encouraged` and `orchestration` replace the `subagent_start` guideline that decides when to delegate and add a `subagent_delegation` prompt section.
- Pi rebuilds prompt options before every run, so switching needs no cleanup. Only the root session applies the mode; nested children keep default guidance, and no mode restricts tools.
- One save owner serves every row and picker invocation, so rapid choices save in order, including delegation and nesting rows that share a document. Closing doesn't cancel an admitted save, and reopening waits for it. [Delegation integration tests](../tests/delegation.test.ts) cover these races.
- The `subagents` footer item shows Current Session's profile set, `*` when the session has its own route edits, and the mode when it isn't `normal`. It publishes to the Cosmic UI footer when active and a plain Pi status entry otherwise.

## Nesting settings

`/subagents settings` edits nesting in Session, Global, or trusted Project scope. Direct children accept integers 1–32 per parent, and depth 0–8. Invalid input is rejected, not clamped. Session changes apply to later batches immediately; persistent changes require `/reload`. Lowering a limit never stops admitted runs.

## Writer workspace default

The writer workspace default has its own unscoped setting. It changes later launches and new sessions, never running writers or existing workspaces, and the settings show how many workspaces in this checkout remain unresolved.

## Custom agents

Custom agents are edited by hand in the root `agents` object of `~/.pi/agent/pi-subagents.json` or a trusted project's `.pi/pi-subagents.json`; [Custom agents](routing.md#custom-agents) defines the fields and launch rules. The settings editors don't change them.

- Agents load with the rest of the document at activation, so edits apply after `/reload`. Current Session has no agent layer, and `/tree` keeps the activation's agents.
- Profile, default-set, nesting, delegation, and writer-workspace writes replace only their own keys, so a document's `agents` object is preserved byte for byte.
- `subagent_models` and `/subagents doctor` list the loaded agents and the ones that fail closed.

## Doctor

`/subagents doctor` checks each item independently and launches nothing:

- Pi's version against the 1.2.0 minimum, and whether Pi's Node binary is still executable;
- configuration diagnostics, the current profile set, and project trust;
- for every profile, the launch preflight against its first eligible route (each distinct route probed once, bounded to 20 seconds); a failing first route is a warning when a fallback exists;
- the same route check for every custom agent after its overrides, and a failure for each agent entry or `agents` object that fails closed;
- each Claude Code or Codex CLI version a route uses, failing below the minimum and warning when missing or unrecognized;
- whether private agent state is writable, the Git version isolated writers would use, the worktree setup and verification commands and `workspaceInclude` patterns, and whether the shared Activity view is installed.

The report is a user notification and never enters the model's context.
