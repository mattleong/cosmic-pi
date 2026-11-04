# Suite UI conventions

Every visible Cosmic Pi surface follows these conventions: tool rows, the footer, Activity, settings, panels, questionnaires, notices, and command output. They keep the suite reading as one product. [Tool presentation](tool-presentation.md) adds the rules specific to tool rows and issues.

Shared helpers implement most of this. Use them instead of writing separators, hint text, or markers by hand:

| Need                           | Helper                                                                                                                                        | Import                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Separator between inline facts | `INLINE_SEPARATOR`, `joinInline(parts)`                                                                                                       | `pi-cosmic-ui/manager`                  |
| Status glyphs                  | `SUITE_STATUS_GLYPHS`, `managerActivityGlyph`, `managerNoticeGlyph`                                                                           | `pi-cosmic-ui/manager`                  |
| Key hints                      | `keyHint`, `joinKeyHints`, `keyHintBar`, `exitKeyHint`, `helpKeyHint`, `moveKeyHint`, `settingAffordanceHint`, `wrapKeyHints`, `formatKeyIds` | `pi-cosmic-ui/manager/key-labels`       |
| List cursor and markers        | `LIST_CURSOR`, `selectionMarker`                                                                                                              | `pi-cosmic-ui/manager/style`            |
| Settings values and rows       | `ON_OFF_SETTING_VALUES`, `settingOnOff`, `AUTO_SETTING_VALUE`, `settingInherited`, `createSettingsChoiceSubmenu`, `settingsListHint`          | `pi-cosmic-ui/manager/settings-surface` |
| Read-only text panel           | `TextPanelComponent`                                                                                                                          | `pi-cosmic-ui/manager/panel`            |
| Durations, ages, sizes, counts | `formatDuration`, `formatRelativeAge`, `formatBytes`, `countLabel`                                                                            | `pi-cosmic-core/display`                |
| Width-safe clipping            | `clipToWidth`                                                                                                                                 | `pi-cosmic-ui/manager`                  |

## Separators

- Use `·` (middle dot with spaces) between facts everywhere: tool rows, footer, Activity, notices, and hint bars.
- Don't use `•`, `|`, or `│` as inline separators. Box-drawing characters are for borders only.

## Key hints

- A hint is a `Key Verb` pair with a Title Case verb, such as `Enter Inspect`. Pairs are joined by `·`: `↑↓ Move · Enter Inspect · Esc Close · ? More`.
- Name keys the way `formatKeyIds` does: `Enter`, `Esc`, `Tab`, `Space`, `PgUp`, `PgDn`, arrows as `↑↓←→`, and modifiers as `C-g`, `A-x`, `⇧Tab`. Show the configured key when Pi has one.
- Keep the default bar short. Put aliases (`j/k`, `h`, `l`, `q`, `Space`, `C-u/C-d`, `gg/G`) and less common keys behind `? More`, which toggles to `? Less`.
- The expanded bar is a superset. It keeps every default pair and adds to it; it never replaces them. `keyHintBar({ hints, more, exit, exitAliases }, expanded)` enforces this.
- When the bar does not fit, wrap it between pairs with `wrapKeyHints`. Never clip a hint mid-pair.
- Show one hint line per surface. A nested view replaces its parent's hint; it never stacks a second one.

## Leaving a surface

- `Esc` backs out one level, or closes the surface at the top level.
- Label it `Esc Back` when nested, `Esc Close` at the top, and `Esc Cancel` for a pending decision. `exitKeyHint(level)` produces each one.
- `q` (and `h` in Vim-style lists) are aliases on non-text surfaces only, and appear only in expanded help.
- Nothing closes on "any key".

## Lists and selection

- Mark the focused row with `›` (`LIST_CURSOR`) in every list, picker, and tree.
- Use `[ ]`/`[x]` for multi-select and `( )`/`(•)` for single-select (`selectionMarker`).
- Show scroll position as `n of N` or `n–m of N`.

## Status glyphs

Each glyph has one meaning, suite-wide:

| Glyph   | Meaning               |
| ------- | --------------------- |
| `✓`     | Succeeded or done     |
| `✗`     | Failed                |
| `⚠`     | Warning               |
| `⊘`     | Stopped or cancelled  |
| `≈`     | Uncertain             |
| `‖`     | Paused                |
| Spinner | Running               |
| `○`     | Queued or not started |
| `?`     | Waiting on the user   |

Don't reuse `○` or `✓` for anything else, such as an unanswered tab or a static tab icon.

## Settings

- Booleans read `on`/`off`. Automatic choices read `auto`. An inherited value reads `inherit (value)`, showing the value that applies.
- Enter says what it does, and the hint names it:
  - On a boolean it toggles and saves: `Enter Toggle`.
  - On an enum it opens a choice list: `Enter Change`. Moving through the list saves nothing; Enter on a new value saves it, and Esc returns without a change.
  - On a group or a view it opens it: `Enter Open`.
- The shared settings surface infers this from each row: `values` of exactly `on`/`off` toggle, any other `values` open a choice list, and a `submenu` opens. Mark a submenu that picks a value with `kind: "setting"` so it reads `Enter Change`.
- A component shown inside a settings surface may implement `settingsHint(expanded)` to supply the single hint line while it is active. Use `settingsListHint` for a component that wraps a pi-tui `SettingsList`.
- Show every row when it fits. Don't hide one row behind a scroll indicator.

## Panels and long text

- Read-only text uses `TextPanelComponent`. It wraps long lines with a hanging indent, scrolls when it doesn't fit, and closes with `Esc` (or `q`).
- Put one fact per row as `Label: value`. Split long lists into one row per item.

## Time

- Durations: `850ms`, `2.1s`, `1m 25s`.
- Ages: `23s ago`.
- Absolute times use the local short form: `10:59 PM` today, otherwise `Nov 3, 10:59 PM`.
- Label times whose meaning isn't obvious, such as `resets 10:59 PM`, so they don't read as a clock.
- Never show epoch numbers.

## Identity

- Show human names first. Add an ID only when two names collide, as a short suffix.
- Full IDs, PIDs, cursors, session paths, and routes belong behind a Technical disclosure.

## Errors and agent text

- A collapsed issue is one short human sentence, such as "File not found", "Rate limited by provider", or "Exited with code 2: missing semicolon". Raw diagnostics, stack frames, and endpoints appear only in expanded detail. See [Issues](tool-presentation.md#issues).
- Agent-authored text, such as reports and results, renders markdown the way Pi renders assistant text. Inline code is styled, not shown with raw backticks.

## Density and width

- State each fact once per surface. Don't repeat titles, statuses, or results.
- Label compact values whose meaning isn't obvious (`cache r163k`, `~1 modified`) when there is room, and fall back to the short form only when narrow.
- Wrapped lines use a hanging indent. Truncation uses `…`. Nothing is cut mid-word without an ellipsis.
