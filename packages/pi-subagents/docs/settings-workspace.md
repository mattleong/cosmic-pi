# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md). `config/store.ts` is the only persistence door; every mutation is an optimistic exact-document write that preserves unrelated sets and routes and rechecks project trust.

## Current session

`/subagents profiles` always opens the current session, the only active working set.

- At session start it is a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Edits change later launches and `agent_profiles` immediately; active runs keep the route captured at launch.
- Applying a saved set resolves all seven profiles, rejects any invalid route, previews the replacement, and commits it with one expected session revision, clearing earlier per-profile changes. It never changes a Project or Global document.
- The current session writes no project, global, or Pi session-history data. It survives `/tree` and `/reload` through the bounded application handoff and clears on `/new`, `/resume`, `/fork`, quit, or restart.
- A `/reload` activation with a session ID takes the handoff and clears it, then restores each part that still decodes, such as a saved route an earlier version wrote with a field it no longer knows. An invalid route override, profile set, or delegation mode falls back to the saved configuration, and the user sees one warning naming what was reset, or, when nothing could be read, that the saved configuration applies with writers read-only and nesting at its minimum. A reset never widens what the session allowed: a profile whose lost route admitted no writer keeps the configuration's route as a read-only session override, and invalid nesting limits are brought within their bounds or take their minimum. If the runtime fails to start before applying the restore, the next `/tree` applies it, or the next `/reload` puts the handoff back unchanged, so a later start restores it the same way. A reload never disables subagents over the handoff.

## Profile editor

One dashboard holds Current session and Saved profiles tabs, named in its top border and each remembering its position. Editors keep the selected profile, candidate, field, and Advanced expansion during internal navigation. The dashboard keeps editors and dialogs in one custom host lifetime, opened on Cosmic UI's shared `screen` surface.

- Both tabs are two-pane surfaces on Cosmic UI's `ListDetailShell`, arranged by `managerArrangement` (side by side, stacked on a narrow frame at least 30 rows tall, else one pane at a time). The shell owns pane focus, the selection, and the arrangement; the editor's fields pane keeps its own field cursor, and the library's preview scrolls through the shell. Each pane that overflows names its position in its heading.
- One status row under the top border carries each tab's context: the set the session is based on and how many profiles differ from it, the saved set an editor writes to, or that saved sets stay separate until used. Messages such as `Updating scout…`, a finished change, and errors take that row while they apply.
- Candidate sections are labelled Primary and Fallback N. Main fields are Model, Reasoning, and File access; Advanced holds Context and OpenAI fast mode where applicable. The fields pane holds only settings; a profile with no candidates shows one `Add model…` row.
- Each candidate's Manage menu (`a`) has Duplicate, valid Move up/Move down, and Delete. Delete confirms and warns when it would disable the profile; there is no standalone Disable.
- Short choice lists (Reasoning, File access, Context, fast mode, Manage, profile search, and a saved set's Actions) open inside the fields or preview pane, keeping the list in view; one pane at a time, they take the pane. The model picker takes the whole dashboard. Confirmations and the name dialogs sit in a band above the bottom border, below the panes they concern.

Keys:

- Up/k and Down/j move without writing; Right/l focuses fields and Left/h the profile list; Enter opens the selected editor or picker.
- Tab and Shift+Tab switch tabs; Esc closes the nearest picker or backs up one level; `?` expands the hint bar to every key below and collapses it again.
- `m` and `e` open Model and Reasoning. `a` opens the candidate's Manage menu, and `+` adds a fallback after a model is chosen.
- `[` and `]` move between candidates, and `/` searches profiles.
- `u` undoes the selected profile's changes from this visit, after a confirmation; the hint appears only when there is something to undo.
- On Current session, `s` saves the session's seven profiles as a new set. Its hint is in the default bar when the session differs from the set it is based on, and behind `? More` otherwise; a saved set's editor neither offers nor accepts it.
- `/subagents profiles worker` opens a profile directly.

Behavior:

- An unpinned value reads as the value it inherits on every surface: `inherit (anthropic/claude-opus-5-5)` for the parent's model (the profile table drops the provider) and `inherit (low)` for the profile's default reasoning, as a picker row too, ahead of the pinned levels. The profile table keeps `inherit (low)` unless its models would clip, then shows the bare level. Pickers keep unavailable configured models on cancellation, which is silent and changes nothing.
- Edits auto-save serially. Conflicts refresh without retrying, and a failed refresh blocks edits until reopening. Catalog cancellation, disposal, and activation replacement suppress late continuations.
- On Current session, `●` marks a profile whose route differs from the set the session is based on, so no saved set holds it; the footer marks the same state with `*`. A saved set's editor writes each change to the set, so it shows no `●`.

### Undo during an editor visit

- Undo restores the selected profile's opening declaration in the current session or a saved set, preserving absence, disabled state, optional fields, and order. It never resets the current session to its saved default.
- Checkpoints survive tab switches, pickers, and forms, but not closing the dashboard. Renaming a set carries its checkpoint, deleting drops it, and a confirmed Use resets the session checkpoint.
- Undo uses checked writes and committed receipts. An external change to the same route withdraws Undo ownership rather than overwriting it, and unrestorable invalid declarations fail safely.

## Model discovery

- The model picker lists the models Pi's registry offers, plus `parent` for the current Pi model. Catalog refresh belongs to the editor's activation and cancellation scope. Success atomically replaces the immutable root Pi-model snapshot; failure keeps the prior generation, and each picker captures one generation.

## Saved-set library

The Saved profiles tab lists sets under Project and Global headings, marking the default and the set the session is based on (`in use`). An empty scope, and an untrusted Project, show a muted note that can't be selected, without reading untrusted configuration. Selecting a set previews its seven resolved profiles, including inherited, disabled, and invalid routes, saying once where they come from and naming only the profiles that differ.

- Enter edits, `u` opens Use, `a` opens Actions (Make/clear default, Copy, Rename, Delete), `→` focuses the preview to scroll it, and Esc closes the library.
- Use previews and confirms before replacing the current session. Opening or editing a set never applies it or makes it a default.
- A saved set's editor names the set in the status row (`Editing Global/name · each change saves to this set · this session is unchanged`). Its edits change only that value, and making a set default affects new sessions only, so no reload is requested.
- Clearing the Project default falls back to Global; clearing Global falls back to built-ins. A selected default can't be deleted until it is replaced or cleared.
- Invalid sets stay visible and can't be used or made default. Project-set status includes routes inherited from the selected Global set. Route-invalid sets remain editable; structurally invalid sets must be deleted and recreated; a malformed unnamed default appears as a clearable repair row.
- Saving is available only from the current session. The dialog takes a name and a destination (Project by default when trusted, otherwise Global). One store action writes all seven effective routes, and refuses fail-closed routes. The profile service holds its revision lock through the transaction, so an interleaved session edit either commits first and rejects the save, or waits.

## Delegation settings

`/subagents settings` edits the delegation mode in Session, Global, or trusted Project scope with the same precedence and timing as nesting. Each scope is one group row whose value lists the values that scope applies; opening it lists the scope's delegation and nesting rows, each with its `inherit (value)` choice first. Rows and summaries derive from the latest choices, so a Global change shows at once in Project's inherited values.

- `normal` leaves the system prompt unchanged. `encouraged` and `orchestration` replace the `agent_start` guideline that decides when to delegate and add a `subagent_delegation` prompt section.
- Pi rebuilds prompt options before every run, so switching needs no cleanup. Only the root session applies the mode; nested children keep default guidance, and no mode restricts tools.
- One save owner serves every row and picker invocation, so rapid choices save in order, including delegation and nesting rows that share a document. Closing doesn't cancel an admitted save, and reopening waits for it. [Delegation integration tests](../tests/delegation.test.ts) cover these races.
- The `subagents` footer item shows the current session's profile set, `*` when the session has its own route edits, and the mode when it isn't `normal`, labeled `subagents:` so it doesn't read as the active model, and as `⧉` in the compact footer. It publishes to the Cosmic UI footer when active and a plain Pi status entry otherwise.

## Nesting settings

`/subagents settings` edits nesting in Session, Global, or trusted Project scope. Direct children accept integers 1–32 per parent, and depth 0–8. Invalid input is rejected, not clamped; invalid limits in a document fail closed instead ([Nesting](routing.md#nesting-and-capacity)). Each limit is the scope's own value or `inherit`, which takes it from the next scope; setting one limit keeps the scope's other limits, and a scope that declares none inherits its whole policy. Session changes apply to later batches immediately; persistent changes require `/reload`. Lowering a limit never stops admitted runs.

## Writer workspace default

The writer workspace default has its own unscoped setting. It changes later launches, including after `/tree`, and new sessions, never running writers or existing workspaces, and the settings say how many worktrees in this checkout still wait on apply or discard, and to ask the agent to review them. Worktree hooks, like the rest of the saved configuration, load at activation; `/tree` keeps the activation's hooks, and edits apply after `/reload`.

## Custom agents

Custom agents are edited by hand in the root `agents` object of `~/.pi/agent/pi-subagents.json` or a trusted project's `.pi/pi-subagents.json`; [Custom agents](routing.md#custom-agents) defines the fields and launch rules. The settings editors don't change them.

- Agents load with the rest of the document at activation, so edits apply after `/reload`. The current session has no agent layer, and `/tree` keeps the activation's agents.
- Profile, default-set, nesting, delegation, and writer-workspace writes replace only their own keys, so a document's `agents` object is preserved byte for byte.
- `agent_profiles` and `/subagents doctor` list the loaded agents and the ones that fail closed.

## Doctor

`/subagents doctor` checks each item independently and launches nothing:

- Pi's version against the 1.5.0 minimum, and whether Pi's Node binary is still executable;
- configuration diagnostics, the current profile set, and project trust;
- for every profile, the launch preflight against its first eligible route (each distinct route probed once, up to four at a time, each bounded to 20 seconds); a failing first route is a warning when a fallback exists;
- the same route check for every custom agent after its overrides, and a failure for each agent entry or `agents` object that fails closed;
- whether private agent state is writable, the Git version isolated writers would use, the configured worktree hooks per event and scope, the checkout's `.worktreeinclude` patterns, and whether the shared Activity view is installed.

The report is a user notification and never enters the model's context.
