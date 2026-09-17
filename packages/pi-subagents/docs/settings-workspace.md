# Settings workspace

Custom screens use the shared live viewport: centered at 90% of terminal width and height at 125×30 or larger, otherwise full bounds. Resize keeps the same component lifetime and selection state.

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md).

## Current Session

`/subagents profiles` always opens Current Session. It is the only active working set. At session start it is a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Editing a profile changes later launches and `subagent_models` immediately. Active runs keep the route captured when they started.

Current Session is independent of saved sets. Applying a saved set resolves all seven profiles first, rejects any invalid route, previews the complete replacement, and commits it with one expected session revision. The replacement becomes Current Session and clears earlier per-profile changes in one transition. It never changes a Project or Global document.

The header reads `Editing Current Session`, without an origin or change count. Session state survives `/tree` and `/reload` through the bounded application handoff. It clears on `/new`, `/resume`, `/fork`, quit, or process restart. These session snapshots are separate from the editor's visit-only Undo checkpoints.

## Profile editor

One dashboard contains Current Session and Saved profiles tabs. A continuous outer border encloses the tabs, status, editor, and internal dialogs. Each tab remembers its position. Fixed-target editors retain the selected profile, candidate, field, and Advanced expansion during internal navigation. Wide terminals show profiles beside their fields; narrow layouts keep the same editing target and scope visible.

Model and Reasoning appear together. Candidate sections spell out Primary and Fallback order. File access and Run with remain main fields; Advanced exposes applicable Context, OpenAI fast mode, and After reporting controls. Each section ends with Manage Primary or Manage Fallback N. Its menu contains only Duplicate, valid Move up/Move down directions, and Delete. Delete requires confirmation and warns when removing the last model will disable the profile. There is no standalone Disable action.

Add fallback and Undo changes appear once under Profile: name. Disabled profiles show Add model there instead. Undo is unavailable when there are no own undoable changes. Below the profile list in the left pane, a Current Session section contains Save these profiles as a set, which captures all seven profiles. Up/Down selects it and Enter opens the save form; `s` opens the same form from either pane. Moving onto this action preserves the selected profile and its field position. Candidate-field memory is separate from profile/session control selection.

Up/k and Down/j navigate rows without writing. Right/l focuses fields; Left/h focuses the profile list. Enter opens the selected editor or picker. Tab and Shift+Tab switch directly between Current Session and Saved profiles, preserving each target's position. Pickers and forms keep their own controls, including j/k row navigation. Esc closes the nearest picker or backs up one level. Persistent footer hints show the other tab's name; `?` opens navigation help. Ordinary cancellation is silent and leaves the route unchanged.

- `m`, `e`, and `r` open Model, Reasoning, and Run with.
- `a` opens the selected candidate's Manage menu. It does nothing while a profile/session control is selected. `+` adds a fallback only after model selection; canceling creates nothing.
- `[` and `]` move between candidates.
- `/` searches profiles. `/subagents profiles worker` opens worker directly.

Runtime changes that require model selection commit both changes together. Pickers distinguish profile-default reasoning from a pinned level and retain unavailable configured models on cancellation. Edits auto-save serially. Pending, saved, failed, and policy-adjustment status remain separate from change markers. Conflicts refresh without retrying; a failed refresh blocks further edits until reopening. Catalog cancellation, disposal, and activation replacement suppress late continuations.

### Undo during an editor visit

`●` marks this editor visit's own changes that Undo can restore. It does not mean a persistent override or an unsaved edit. Undo changes restores the selected profile's opening declaration, in either Current Session or a saved set. Saved declarations preserve absence, disabled state, optional fields, and candidate order rather than replacing inheritance with resolved candidates. Undo does not reset Current Session to its saved default.

Checkpoints survive tab switches, pickers, and internal forms, but not closing the whole dashboard. Renaming a saved set carries its checkpoint; deleting it drops the checkpoint. A new set gets a checkpoint when first opened. A confirmed Use replacement resets the session checkpoint.

Undo uses checked writes and committed receipts to identify owned changes. An external change to the same route withdraws that route's Undo ownership rather than overwriting it. Unsupported invalid raw declarations cannot be restored and fail safely. Exact-document conflicts, project trust, session revisions, and current activation checks still apply.

## Native model discovery

The Claude picker asks the installed CLI for its catalog without inference. Before each lookup it reads only the schema-validated `model` field from the user-level `$HOME/.claude/settings.json`, limited to 64 KiB and regular files. It follows this exact user config path's symlink to support dotfile managers, then reads the canonical target through core `SafeFile`. `HOME` matches the sanitized child environment; stripped `CLAUDE_CONFIG_DIR` overrides and project settings are not consulted. Missing or invalid settings use `default`.

The probe preserves aliases and context suffixes such as `[1m]`. Its selector is part of the session cache key, so changing the user preference updates discovery on the next picker access without reload. When a preference is set, discovery combines the default and preferred-selector catalogs. Both probes must succeed. Exact duplicate selectors use the preferred probe's metadata; distinct aliases and context selectors remain separate choices. Each probe has its own 10-second deadline and confirmed process cleanup. Discovery keeps settings sources disabled, explicitly disables hooks, and uses strict empty MCP configuration. It does not change subagent launch policy.

## Saved-set library

The Saved profiles tab groups the library by Project and Global. Session is not a library scope. Untrusted Project rows stay visible but unavailable, without reading their configuration. Selecting a set previews its seven resolved profiles, ordered candidate models and effort, including inherited, disabled, and invalid routes. Wide screens show the preview beside the list; narrower screens stack it below when height permits. Long routes are abbreviated in the preview and remain available in the editor.

Enter edits the selected set, `u` opens Use, `a` opens More, and Esc closes the library. Use previews all seven resolved profiles and requires confirmation before replacing Current Session. Success returns to Current Session and resets its visit checkpoint. Opening or editing a set never applies it implicitly or makes it a default.

More contains Make/clear default, Copy, Rename, and Delete. Clearing the Project default falls back to Global; clearing Global falls back to built-ins. The dashboard keeps editors and internal forms in one custom host lifetime rather than closing and reopening host screens.

A saved editor reads `Editing name · session not affected`, with Project or Global scope always visible separately. Its edits change only that library value. Making a set default affects new sessions only. Saving and editing do not request reload because saved values are not the active working set.

Invalid saved sets remain visible and cannot be used or made default. Project-set status includes routes inherited from the selected Global set. A set with invalid routes remains editable so explicit routes can repair it. A structurally invalid set must be deleted and recreated. A malformed unnamed default appears as a clearable repair row. A selected default must first be replaced or cleared before deletion. Store mutations retain exact-document optimistic conflict checks and preserve unrelated sets and routes.

Saving is available only from Current Session. The Save Current Session form contains a Project or Global destination and a name. One `createProfileSetFromSnapshot` store action writes all seven effective session routes. Saving changes neither the default nor the editing target. The controller refuses to save fail-closed Project or Global routes. The profile service holds its revision lock through the document transaction, so an interleaved session edit either commits first and rejects the save or waits until the reviewed snapshot has been saved.

## Nesting settings

`/subagents settings` still edits nesting policy in Session, Global, or trusted Project scope. Direct children accept integers from 1 through 32 and depth accepts integers from 0 through 8. The controller rejects invalid input instead of clamping it. Session changes apply to later batches immediately. Persistent nesting writes require `/reload`; lowering a limit never stops admitted runs.

## Module responsibilities

- `src/settings/controller.ts` registers commands, deep links, and nesting/workspace settings. Application services retain session snapshots across allowed replacement paths.
- `profile-dashboard.ts` owns checked route writes, scoped dialog waits, catalog cancellation, and activation-bound UI cleanup. `profile-write-context.ts` shares trust and conflict-token capture. `profile-dashboard-component.ts` owns the single custom host lifetime, tabs, cached fixed-target editors, and internal forms. Refreshes advance editable drafts with their write guards; owned rename transfers all profile/candidate navigation memory before reconciliation. `profile-set-actions.ts` handles library mutations and confirmed replacement; `profile-dashboard-dialogs.ts` owns internal confirmation and name dialogs.
- `profile-edit-visit.ts` owns pure visit checkpoints and receipt-based Undo ownership. `config/store.ts` owns exact declaration restoration and committed document receipts, with optimistic document and trust checks.
- `profile-workspace.ts` composes fixed-target editing. Its state, save, and picker modules separate navigation, serialized writes, and cancellable selection work. `profile-set-picker.ts` owns library selection; `profile-set-save-form.ts` owns the destination/name form.
- `profile-route-editor.ts` owns fixed-target route drafts and canonical validation messages. `profile-model-catalog.ts` owns atomic Pi catalog refresh and runtime-specific picker loading.
- `src/settings/ui/` contains pure row models, selectors, projections, responsive geometry, and rendering.
