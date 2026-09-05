# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md).

## Current Session

`/subagents profiles` always opens Current Session. It is the only active working set. At session start it is a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Editing a profile changes later launches and `subagent_models` immediately. Active runs keep the route captured when they started.

Current Session is independent of saved sets. Applying a saved set resolves all seven profiles first, rejects any invalid route, previews the complete replacement, and commits it with one expected session revision. The replacement becomes Current Session and clears earlier per-profile changes in one transition. It never changes a Project or Global document.

The header names what Current Session is based on and how many profiles have changed. Session state survives `/tree` and `/reload` through the bounded handoff. It clears on `/new`, `/resume`, `/fork`, quit, or process restart.

## Profile editor

The editor keeps the original framed list/detail presentation. Wide terminals show the selected list beside its details; smaller terminals use the original stacked or compact view. Profiles, Primary/Fallback choices, and candidate fields remain separate pages. A profile with one candidate opens its fields directly and returns directly to Profiles on Back. Multiple candidates keep the choice-order page.

Model, Reasoning, File access, and Run with remain the main fields. Advanced expands Context, OpenAI fast mode, and After reporting only where applicable. Move up and Move down appear only for routes with multiple candidates. Delete model remains a direct field row, including its last-candidate warning, and the original Actions picker contains the full route menu. Field and model pickers keep their framed full-page presentation.

Faster paths are available without changing those screens:

- `m`, `e`, and `r` open Model, Reasoning, and Run with from any workspace page.
- `a` opens Actions immediately. `+` adds a fallback after choosing its model, using the selected candidate as the starting point. Canceling creates nothing; selecting the model saves one complete candidate and opens its fields.
- `f` opens the original candidate list. `[` / `]` switch candidates without resetting the selected field.
- `p` opens saved sets, `s` saves Current Session, and `t` selects the editing target. These are shortcuts, not a new header or tab bar.
- `?` shows shortcuts. Enter/Right advances; Esc/Left backs out through the original pages. Tab and Shift+Tab navigate pages without opening a field picker.
- `/subagents profiles worker` opens worker directly.

The editor remembers candidate, field, and Advanced expansion when returning through pages or reopening after a saved-set action. Inapplicable fields fall back to Model. Candidate moves preserve the selected candidate. Removal and Disable still require confirmation; removing the last candidate warns that it disables the profile.

Model and profile search start ready to type and cancel with one Esc or configured cancel binding. Picker labels show each default/current status once; the explicit profile-default reasoning choice remains distinct from a pinned level. Help and confirmation hints follow the configured keys. Runtime changes requiring a model selection commit together; canceling leaves the route unchanged. Edits auto-save serially. Routine success shows a small Saved indicator in the existing frame instead of consuming field rows, including on short terminals. Policy-adjustment notices and warnings remain visible. Wide layouts give long model names more list width while keeping at least half the inner width for the divider and detail pane. Conflicts refresh without retrying, and failed refresh blocks further edits until reopening. Catalog cancellation and disposal abort outstanding work and ignore late continuations.

## Saved-set library

`p` opens a separate library grouped as Project and Global. Session is not a library scope. Untrusted Project rows stay visible but unavailable, without reading their configuration.

Enter edits the selected set directly. `u` previews and confirms replacement of all seven Current Session profiles, then returns to Current Session on success. More contains Make/clear default, Copy, Rename, and Delete. Clearing the Project default falls back to Global; clearing Global falls back to built-ins. Closing the library returns to the target that opened it unless that target was renamed or deleted.

The dashboard closes each custom screen before opening the next, then reopens the editor on the same page with its profile, candidate, field, and Advanced expansion where possible. Changing targets resets the candidate to Primary.

Using a set changes only Current Session. Editing a saved set changes only that library value, and the editor header reads `Saved set · Project/name · Current Session unchanged` or its Global equivalent. Making a set default affects new sessions only. Saving and editing no longer ask for reload because saved values are not the active working set.

Invalid saved sets remain visible and cannot be used or made default. Project-set status includes routes inherited from the selected Global set. A set with invalid routes remains editable so explicit routes can repair it. A structurally invalid set must be deleted and recreated. A malformed unnamed default appears as a clearable repair row. A selected default must first be replaced or cleared before deletion. Store mutations retain exact-document optimistic conflict checks and preserve unrelated sets and routes.

`s` opens one Save Current Session form containing Project or Global destination and a name, even while editing a saved set. One `createProfileSetFromSnapshot` store action writes all seven effective session routes. Saving does not make the new set a default. The controller refuses to save fail-closed Project or Global routes. The profile service holds its revision lock through the document transaction, so an interleaved session edit either commits first and rejects the save or waits until the reviewed snapshot has been saved.

## Nesting settings

`/subagents settings` still edits nesting policy in Session, Global, or trusted Project scope. Direct children accept integers from 1 through 32 and depth accepts integers from 0 through 8. The controller rejects invalid input instead of clamping it. Session changes apply to later batches immediately. Persistent nesting writes require `/reload`; lowering a limit never stops admitted runs.

## Module responsibilities

- `src/settings/controller.ts` owns commands and profile deep links, fixed-target editor opening, route saves, optimistic revisions, and host lifecycle callbacks.
- `src/settings/profile-dashboard.ts` owns the close/reopen screen loop, target switching, Current Session replacement, saved-set mutations, and trust checks.
- `src/settings/profile-workspace.ts` owns the original page navigation, selection memory, serialized saves, atomic candidate edits, and cancellable catalog loads. It delegates presentation and full-page selectors to `settings/ui/`.
- `src/settings/profile-set-picker.ts` owns the grouped library and More actions. `profile-target-picker.ts` owns direct target selection; `profile-set-save-form.ts` owns the destination/name form.
- `src/settings/profile-route-editor.ts` owns fixed-target route drafts and canonical validation messages.
- `src/settings/profile-model-catalog.ts` owns atomic Pi catalog refresh and runtime-specific picker loading.
- `src/settings/ui/` contains pure selectors, projections, responsive geometry, and rendering.
