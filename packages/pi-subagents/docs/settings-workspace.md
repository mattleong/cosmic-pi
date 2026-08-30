# Settings workspace

Part of the [pi-subagents](../README.md) architecture documentation. Routing policy is in [routing.md](routing.md).

## Current Session

`/subagents profiles` always opens Current Session. It is the only active working set. At session start it is a complete seven-profile snapshot resolved from the trusted Project default, Global default, and built-ins. Editing a profile changes later launches and `subagent_models` immediately. Active runs keep the route captured when they started.

Current Session is independent of saved sets. Applying a saved set resolves all seven profiles first, rejects any invalid route, previews the complete replacement, and commits it with one expected session revision. The replacement updates the session starting point and clears per-profile changes in one transition. It never changes a Project or Global document.

The header names what Current Session is based on and how many profiles have changed. Session state survives `/tree` and `/reload` through the bounded handoff. It clears on `/new`, `/resume`, `/fork`, quit, or process restart.

## Profile editor

At 100 columns or more, the editor uses the shared list/detail frame with profiles or Primary/Fallback choices on the left and selected details on the right. Widths from 60 through 99 use a stacked list/detail dashboard. Narrow terminals show the selected detail, and very short terminals keep a bounded safety-first summary. Every layout includes the selected profile description and preserves exact width and height bounds.

Profiles open into ordered Primary and Fallback rows. Candidate settings show Model, Reasoning, File access, and Run with first. Run with combines host and runtime into the six Local or Herdr plus Pi, Claude, or Codex choices. Advanced expands Context, OpenAI fast mode, and Report policy only when those values apply or need repair.

The main footer is `Enter Edit`, `p Profile sets`, and `Esc Close`. Route additions, copies, reordering, removal, disable, and restore operations live in the explicit Actions selector. Destructive choices require Enter confirmation and allow Esc cancellation. Model catalogs load asynchronously from one captured generation; cancellation or disposal aborts outstanding catalog work and ignores late UI continuations.

## Saved-set library

`p Profile sets` opens a separate library grouped as Project and Global. Session is not a library scope. Untrusted Project rows stay visible but unavailable.

Enter opens actions for the selected saved set:

- Use in Current Session
- Edit saved set
- Make default for new sessions, or clear the current default so Project uses Global or Global uses built-ins
- Copy
- Rename
- Delete

Using a set changes only Current Session. Editing a saved set changes only that library value, and the editor header reads `Saved set · Project/name · Current Session unchanged` or its Global equivalent. Making a set default affects new sessions only. Saving and editing no longer ask for reload because saved values are not the active working set.

Invalid saved sets remain visible and cannot be used or made default. Project-set status includes routes inherited from the selected Global set. A set with invalid routes remains editable so explicit routes can repair it. A structurally invalid set must be deleted and recreated. A malformed unnamed default appears as a clearable repair row. A selected default must first be replaced or cleared before deletion. Store mutations retain exact-document optimistic conflict checks and preserve unrelated sets and routes.

`s Save Current Session` prompts for Project or Global destination and a name. One `createProfileSetFromSnapshot` store action writes all seven effective session routes. Saving does not make the new set a default. The controller refuses to save fail-closed Project or Global routes. The profile service holds its revision lock through the document transaction, so an interleaved session edit either commits first and rejects the save or waits until the reviewed snapshot has been saved.

## Nesting settings

`/subagents settings` still edits nesting policy in Session, Global, or trusted Project scope. Direct children accept integers from 1 through 32 and depth accepts integers from 0 through 8. The controller rejects invalid input instead of clamping it. Session changes apply to later batches immediately. Persistent nesting writes require `/reload`; lowering a limit never stops admitted runs.

## Module responsibilities

- `src/settings/controller.ts` owns `/subagents`, `/subagents settings`, Current Session replacement, saved-set orchestration, trust checks, optimistic revisions, and host lifecycle callbacks.
- `src/settings/profile-workspace.ts` owns the disposable Current Session or fixed saved-set editor, catalog cancellation, and route action flow.
- `src/settings/profile-set-picker.ts` owns the grouped saved-set library and explicit saved-set action menu.
- `src/settings/profile-route-editor.ts` owns fixed-target route drafts and canonical validation messages.
- `src/settings/profile-model-catalog.ts` owns atomic Pi catalog refresh and runtime-specific picker loading.
- `src/settings/ui/` contains pure selectors, projections, responsive geometry, and rendering.
