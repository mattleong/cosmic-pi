# Streamlined profile editor plan

Status: superseded. The user rejected the visual redesign and requested the original framed list/detail UI with flow-only improvements. The implementation now preserves the original pages and Advanced controls, adds direct shortcuts, skips the single-candidate page, and remembers navigation state. Current behavior is documented in [settings-workspace.md](settings-workspace.md). The design below is historical, not the current UI specification.

## Agreed direction

- Use a profile list beside an editable candidate form.
- Auto-save each completed edit. No workspace-wide Apply button.
- Treat model/reasoning, host/runtime, fallbacks, and saved sets as first-class workflows.
- `/subagents profiles` always opens Current Session. Editing a saved set never applies it implicitly.

The implementation changes navigation, not profile routing or scope semantics.

## Main screen

Wide terminal, 100 columns or more. Values below are illustrative.

```text
Subagent profiles
Editing: [Current Session v]    [Save session as…]    [Saved sets]
Based on Global/default · 2 profiles changed

Profiles          scout · Primary                           [Candidate v]
> scout           [Primary]  [Fallback 1]  [Fallback 2]  [+ Add]
  researcher
  planner         Model              provider/model
  worker          Reasoning          low · profile default
  reviewer        Run with           Local Pi
  oracle          File access        Read-only
  generalist      Context            Fresh
                  OpenAI fast mode   Off

                  Fresh starts without earlier context.
                  Changes affect future launches, not active runs.

Tab Change section · Enter Edit · m Model · e Reasoning · ? More · Esc Close
```

The diagram's brackets denote focusable controls, not a promise of mouse support.

Selecting a profile immediately updates the form. No profile detail page and no candidate detail page. Candidate tabs select the route entry being edited; Primary is first. When there are too many tabs, use a bounded scrolling strip with the selected position and total visible. The candidate picker lists the complete ordered route with model and Run with summaries.

Field order is Model, Reasoning, Run with, File access, Context, OpenAI fast mode, After reporting. Show applicable fields without an Advanced expander. Keep an incompatible persisted value visible with its reason and repair option. Do not imply that a hidden field is unrestricted.

The form's help area explains the focused field in one or two lines. Do not repeat the profile description beside every field. The selected profile's description is available in help.

Remember each profile's selected candidate and field within the open workspace. Switching candidates retains the field by identity, not row number. If it does not apply, select Model. A new opening starts at the primary candidate's Model field. Switching editing targets preserves the profile and field where possible, but resets candidate selection to Primary.

## Keyboard contract

Displayed navigation hints use the host keybinding labels. Workspace shortcuts stay outside text entry and modal input.

| Input                    | Workspace behavior                                                    |
| ------------------------ | --------------------------------------------------------------------- |
| Tab / Shift+Tab          | Move among header controls, profile list, and editor.                 |
| Up / Down, j / k         | Move within the focused section without changing a value.             |
| Left / Right in header   | Select a header control.                                              |
| Enter on a profile       | Focus its Model field directly.                                       |
| Enter on a field         | Open its value picker.                                                |
| Enter on candidate strip | Open the ordered candidate picker.                                    |
| `[` / `]`                | Select previous/next candidate, keeping the field selected.           |
| m / e / r                | Open Model / Reasoning / Run with for the selected candidate.         |
| f                        | Open candidate picker.                                                |
| a                        | Begin Add fallback.                                                   |
| p                        | Open saved-set library.                                               |
| s                        | Save Current Session as a saved set.                                  |
| ?                        | Show complete shortcuts and profile help.                             |
| Esc                      | Cancel an open picker or confirmation; otherwise close the workspace. |

Shortcuts operate only outside text entry and modal pickers. A picker owns its input, so typing a model name cannot trigger workspace commands. Provide visible controls for every shortcut action.

Initial focus is on the profile list, with the primary form already visible. Thus choosing a profile and pressing m opens its model picker without entering the form first. `/subagents profiles worker` opens worker with Model focused. Add profile-name completion and reject unknown names rather than silently choosing another profile.

## Editing values

### Model

1. Press m or activate Model.
2. Open the model picker with search active and the current model selected.
3. Type to filter, use arrows to select, Enter to commit.
4. Return to the same field and candidate with a brief Saved status.

Keep scoped/all-model selection as an explicit picker control. Do not change shared picker behavior for other extensions unless separately justified. Long model catalogs may use a full-page picker; small choices should use a compact picker over the workspace.

### Reasoning and other small choices

Enter opens choices adjacent to the field where geometry permits. Up/Down previews selection; Enter saves; Esc cancels without writing. No auto-saving while merely moving through options.

Show the effective reasoning level alongside profile default. An unsupported stored value must remain understandable and repairable.

### Run with

Keep the six combined Local/Herdr × Pi/Claude/Codex choices. Do not split host and runtime into additional menus.

If the new runtime needs a different model, continue directly to model selection in one pending edit. Commit the complete validated candidate once. Esc at either step cancels the entire edit. Report any automatic context, reasoning, fast-mode, or report-policy adjustments after the save.

### Save feedback

Keep auto-save serialized initially. Show Saving/Saved next to the target or in one bounded status line. Do not turn every success into a separate confirmation screen.

Do not permit overlapping edits or target switches during a submitted save. Keep existing optimistic revision/document checks. A conflict refreshes the displayed values and tells the user that their change was not applied; never silently retry it. Refresh failure blocks mutations with a clear reopen instruction. Navigation during writes and write queues are outside this first iteration.

## Fallback management

The candidate picker is a compact route manager, not a gateway to another settings page.

```text
scout · Candidate order
> Primary      provider/model-a    Local Pi
  Fallback 1   provider/model-b    Herdr Codex
  Fallback 2   provider/model-c    Local Claude

[Add] [Duplicate] [Move earlier] [Move later] [Remove]
```

- Enter on a candidate selects it and returns to the existing form.
- Add is also available directly above the form and through a.
- Add opens a compact candidate form seeded from the selected candidate. Select Run with and Model, with other values available in the same form. Add commits once; Esc creates nothing. Never save a placeholder candidate before model selection.
- Duplicate intentionally inserts an exact copy after the selected candidate, saves once, and selects the copy for editing.
- Moving earlier/later saves one reorder and keeps the same candidate selected. Controls remain focused to allow repeated moves without reopening the menu. Boundary moves are unavailable.
- Remove previews the selected entry and requires confirmation. Removing the final candidate explicitly warns that it disables the profile.
- Enforce the existing 32-candidate limit. Disable Add and Duplicate with a reason when full.
- Put Disable profile and Restore/inherit under a separate profile action control. Reset wording and preview must reflect the editing target.

Disabled profiles show Enable/Add directly in the form. Invalid routes show the validation problem and direct repair/reset actions, not a dead-end detail page.

## Saved sets and editing targets

The header's Editing selector contains Current Session and available saved sets grouped by Project and Global. Selecting a set opens it for editing immediately, with no intervening action menu.

Saved-set header example:

```text
Editing: [Global/work v]    [Use in session]    [Saved sets]
Editing saved configuration · Current Session unchanged
```

Keep the target and scope visible even on narrow terminals. Do not use only color to distinguish them. Project options remain unavailable when untrusted, without reading their configuration.

Saved sets opens the library with direct actions:

```text
Saved sets
> Global/work      Default for new sessions
  Global/cheap
  Project/review

Enter Edit · u Use in session · s Save session as… · More… · Esc Back
```

- Enter edits the selected set directly. This removes the current Edit saved set action-menu step.
- Use in session previews replacement of all seven profiles and requires confirmation. On success, return to the Current Session editor. Active runs remain unchanged.
- Save session as opens one form containing destination and name. Save creates a complete snapshot; it does not apply the set or make it default. While editing a saved set, the action must still explicitly say Save Current Session, not imply it saves the displayed set.
- More contains Make/clear default, Copy, Rename, and Delete. Preserve default-pointer and deletion restrictions.
- Closing the library without choosing a new target returns to the editor and target that opened it.
- Invalid sets remain visible and editable where existing repair rules allow. Do not enable Use or Make default for invalid sets.

## Smaller terminals

At 60–99 columns, replace the sidebar with a compact Profile selector above the candidate strip and the same editable form. Enter on Profile opens a compact list. Model/Reasoning/Run with shortcuts still work directly.

Below 60 columns, stack target, profile, candidate, and fields. Scroll the form with a stable focused row. Small choice pickers may use the full screen. Never introduce separate profile-summary or candidate-summary pages to fit the width.

At very short heights, prioritize target, selected profile/candidate, focused field, and status. Confirmation views must retain the destructive consequence and confirm/cancel controls. Provide scrolling details when the preview cannot fit. Reuse shared bounded layout primitives.

## Implementation slices

1. Replace the three-level workspace state with focused sections and a directly editable form. Update pure render/model helpers under `src/settings/ui/`. Preserve the existing route-draft operations.
2. Add field shortcuts, focus retention, candidate selection, atomic Add, and direct route management. Keep model loads cancellable and ignore results after disposal.
3. Add the header target selector, direct saved-set Edit, single-form session snapshot saving, and profile command arguments in `src/settings/controller.ts`.
4. Verify narrow/short layouts, document the new flows in `settings-workspace.md`, and update `ARCHITECTURE.md` only for actual ownership or lifecycle changes.

Keep I/O and persistence in existing controller/store boundaries. Keep pure rendering in `settings/ui/`. Split the workspace orchestration by actual responsibilities rather than growing its already-large component. No config schema, profile definition, launch routing, or storage migration changes are intended.

## Acceptance checks

Count activations separately from arrow navigation and typed search text.

| Task, with profile already selected | Target                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| Change primary model                | m, select model, Enter. No intermediate page.                 |
| Change reasoning                    | e, select level, Enter. No intermediate page.                 |
| Edit fallback reasoning             | Select fallback in place, e, select level, Enter.             |
| Switch Run with                     | r, choose combination, Enter; model selection only if needed. |
| Edit saved set                      | Editing selector, choose set, Enter; form immediately usable. |
| Add fallback                        | a, complete candidate form, Add; one route mutation.          |

Behavior tests must cover focus retention, picker cancellation without writes, whole-candidate commits, duplicate/reorder selection, destructive confirmation, correct save targets, conflict recovery, project trust, and canceled/disposed catalog loads. Cover small-terminal reachability without asserting exact rendered copy, colors, or frame layout.

Run the relevant package tests first, then `pnpm validate`. Manually exercise long model names, all seven profiles, a full 32-candidate route, disabled/invalid routes, saved-set/session separation, and short terminals.

## Not included

Bulk multi-profile editing, a spreadsheet layout, undo history, queued background saves, new routing semantics, and mouse support. These should not delay removing the existing navigation depth.
