# Suite UI conventions

Every visible Cosmic Pi surface follows these conventions: tool rows, the footer, Activity, settings, panels, questionnaires, notices, and command output. They keep the suite reading as one product. [Tool presentation](tool-presentation.md) adds the rules specific to tool rows and issues.

Shared helpers implement most of this. Use them instead of writing separators, hint text, or markers by hand:

| Need                            | Helper                                                                                                                                                                                                                                         | Import                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Separator between inline facts  | `INLINE_SEPARATOR`, `joinInline(parts)`                                                                                                                                                                                                        | `pi-cosmic-ui/manager`                                                                 |
| Status glyphs                   | `SUITE_STATUS_GLYPHS`, `managerActivityGlyph`, `managerNoticeGlyph`                                                                                                                                                                            | `pi-cosmic-ui/manager`                                                                 |
| Key hints                       | `keyHint`, `joinKeyHints`, `keyHintBar`, `keyHintBarParts`, `exitKeyHint`, `helpKeyHint`, `moveKeyHint`, `settingAffordanceHint`, `wrapKeyHints`, `keyHintRows`, `formatKeyIds`, `configuredKeyLabels`, `piSelectHintKeys`, `movementKeyLabel` | `pi-cosmic-ui/manager/key-labels`                                                      |
| Hints on a framed surface       | `framedKeyHintBar`, `framedKeyHints`, `borderKeyHint`, `fittedBorderKeyHint` (border text and overflow); `framedBodyWithHints`, `framedDivider` (rows above the border)                                                                        | `pi-cosmic-ui/manager/key-labels`, `pi-cosmic-ui/manager/list-detail-shell`            |
| Text inside a frame             | `framedGutter`, `FRAME_GUTTER`                                                                                                                                                                                                                 | `pi-cosmic-ui/manager/list-detail-shell`                                               |
| List cursor and markers         | `LIST_CURSOR`, `selectionMarker`                                                                                                                                                                                                               | `pi-cosmic-ui/manager/style`                                                           |
| Settings surface                | `openSettingsList` (string header), `settingsSurfaceHeader`, `SettingsSurfaceItem` (`kind`, `children`, `summary`), `createSettingsGroupSubmenu`                                                                                               | `pi-cosmic-ui/boundary/host-settings-command`, `pi-cosmic-ui/manager/settings-surface` |
| Settings values and rows        | `ON_OFF_SETTING_VALUES`, `settingOnOff`, `AUTO_SETTING_VALUE`, `settingInherited`, `createSettingsChoiceSubmenu`, `settingsListHint`                                                                                                           | `pi-cosmic-ui/manager/settings-surface`                                                |
| Columns                         | `managerTable`                                                                                                                                                                                                                                 | `pi-cosmic-ui/manager/table`                                                           |
| Read-only text panel            | `TextPanelComponent`                                                                                                                                                                                                                           | `pi-cosmic-ui/manager/panel`                                                           |
| Bare `/<command>` help          | `registerExtensionCommand` (with `overviewNotes`), `extensionCommandOverview`                                                                                                                                                                  | `pi-cosmic-core/host-command`                                                          |
| Expansion affordance            | `renderExpansionAffordance`, `toolExpandHint`                                                                                                                                                                                                  | `pi-cosmic-ui/tool`                                                                    |
| Expanded tool bodies            | `expandedBody`, `expandedFields`, `expandedText`, `expandedDetails`, … ([layout](tool-presentation.md#expanded-body-layout))                                                                                                                   | `pi-code-previews`                                                                     |
| Durations, times, sizes, counts | `formatDuration`, `formatRelativeAge`, `formatClockTime`, `formatBytes`, `countLabel`                                                                                                                                                          | `pi-cosmic-core/display`                                                               |
| Wrapping a line of facts        | `wrapFacts(facts, width, hangingIndent)` (breaks between whole facts, then before `→`, then after `/`)                                                                                                                                         | `pi-cosmic-ui/manager`                                                                 |
| Settings command text           | `settingsSubcommand` (help, errors, confirmations), `settingsStatusText`, `wrapNoticeText`                                                                                                                                                     | `pi-cosmic-ui/boundary/host-settings-command`                                          |
| Width-safe clipping             | `clipToWidth` (closes up the space before `…`)                                                                                                                                                                                                 | `pi-cosmic-ui/manager`                                                                 |

Every surface must read well at both a desktop terminal (180×56) and a phone client (57×46). Check both widths in the presentation gallery, and add a 57-column scenario for every surface you change.

## Separators

- Use `·` (middle dot with spaces) between facts everywhere: tool rows, footer, Activity, notices, and hint bars.
- Don't use `•`, `|`, or `│` as inline separators. Box-drawing characters are for borders, gutters, and tree structure only.

## Key hints

- A hint is a `Key Verb` pair with a Title Case verb, such as `Enter Inspect`. Pairs are joined by `·`: `↑↓ Move · Enter Inspect · Esc Close · ? More`.
- Name keys the way `formatKeyIds` does: `Enter`, `Esc`, `Tab`, `Space`, `PgUp`, `PgDn`, arrows as `↑↓←→`, and modifiers as `C-g`, `A-x`, `⇧Tab`. Show the configured key when Pi has one. Arrows inside a hint name keys; they are not glyphs.
- Configured keys from Pi go through the same formatting. A surface given `keybindingLabel` reads its keys with `configuredKeyLabels`, and a surface built on pi-tui lists reads Pi's `tui.select.*` keys with `piSelectHintKeys`. The default bar names only each binding's primary key (`binding(id).key`, `primary(id)`); the binding's other keys, such as `C-c` for cancel, join `exitAliases`. Up and down read as one label, `↑↓` (`movementKeyLabel`), never `↑/↓`.
- Keys a host handles beside a shared component belong in its bar as pairs, never in subtitle text: the model picker's scope switch reads `Tab All models` (`SearchableSelectPage`'s `hints`).
- Keep the default bar short. Put aliases (`j/k`, `h`, `l`, `q`, `C-c`, `Space`, `C-u/C-d`, `gg/G`) and less common keys behind `? More`, which toggles to `? Less`.
- The expanded bar is a superset. It keeps every default pair and adds to it; it never replaces them. `keyHintBar({ hints, more, exit, exitAliases }, expanded)` enforces this, and every bar with an exit goes through it (`keyHintBarParts` or `framedKeyHintBar` when the surface needs the pieces).
- Expanded, the exit names its aliases in one pair, primary key first: `Esc/C-c/q Close`, `Esc/h Back`. An alias whose verb differs gets its own pair, such as `q Close` beside `Esc/h Back` in a nested view. Never list an alias as a separate pair with the same verb (`C-c Close · q Close`).
- Show one hint line per surface. A nested view replaces its parent's hint; it never stacks a second one.

### Action keys

- Each action has exactly one key. Use its letter wherever one exists: `x` Stop, `i` Interrupt, `m` Message, `e` Rename, `c` Clear.
- An action list shows that same key, `[x] Stop`, and the hint bar names the same key, `x Stop`. Never offer the same action under a letter in one place and a digit in another.
- An action reads the same on every row: `[x] Stop` on a parent and on its child, never `Stop agent` on one and `Stop` on another. The pane and the confirmation already name the item. Producers supply the label; Activity shows it as given.
- A confirmation names the item and what else the action affects, such as `Stop "Review authentication" and its 5 subagents?`. Never write `this agent`.
- Digits are only for actions that have no letter, and then the list and the hint both show the digit.

### Wrapping

- When a bar doesn't fit, wrap it between complete `Key Verb` pairs: `wrapKeyHints(hint, width)` returns the rows, and `keyHintRows(hint, width, style)` returns them styled with the surface's one-column gutter. Never clip a pair mid-way.
- Wrapping takes rows; it never drops essential hints. At every width, including 57 columns, the bar keeps Move or Scroll, the primary action, and the exit (`Esc Close`, `Esc Back`, or `Esc Cancel`). Only `? More` content may wait for expansion.
- A framed surface puts its whole bar in the bottom border when it fits. Otherwise the border keeps the exit and `? More` (or `? Less`), and the remaining pairs wrap into rows above it, set off by a divider: `framedKeyHintBar(bar, expanded, inner)` returns the border text and the overflow, and `framedBodyWithHints` places the wrapped overflow rows. This holds for expanded help too: the border never empties while its pairs move into the body. Never choose a shorter bar by dropping pairs, and never clip the border without `…`.
- Each pane of a multi-pane surface names its own movement and what Enter does there, such as `Enter Open` in a list and `Enter Change` on a field.
- Offer only keys that do something now. An empty list drops Move, Inspect, and its item actions; the exit and `? More` stay.
- One key has one verb everywhere it appears: Activity's `w` reads `w Next input` in its banner and in its help.

## Leaving a surface

- `Esc` backs out one level, or closes the surface at the top level.
- Label it `Esc Back` when nested, `Esc Close` at the top, and `Esc Cancel` for a pending decision. `exitKeyHint(level)` produces each one.
- Show only that primary exit key. Aliases such as `C-c`, `q`, and `h` (in Vim-style lists) work where they apply but appear only in the expanded `? More` help, never as `Esc/C-c` in the default bar. `q` and `h` are aliases on non-text surfaces only.
- Expanded, every key that leaves the level is named, in one pair: if `C-c` closes a settings surface, picker, or panel, its expanded exit reads `Esc/C-c/h/q Close` like Activity's `Esc/C-c/q Close`.
- A surface with a pending sub-state backs that out first: with a settings or picker filter applied, `Esc Clear` clears the filter, and the next `Esc` closes. A picker opened straight into search, where the search is the whole surface, reads `Esc Cancel` instead.
- Nothing closes on "any key".

## Lists and selection

- Mark the focused row with `›` (`LIST_CURSOR`) in every list, picker, and tree. Never let a pi-tui default such as `→` stand in for it.
- Use `[ ]`/`[x]` for multi-select and `( )`/`(•)` for single-select (`selectionMarker`).
- A picker that chooses a value marks every row `( )` and the current value `(•)`, so the current value stays visible while the cursor moves: settings choice lists do this, and `SearchableSelectPage` does it when given `markedValue`. Action and navigation lists carry no marker. Don't repeat the marker as `(current)` text.
- A picker's inherit row reads `( ) inherit (value)` with the value it would apply, such as `( ) inherit (low)` or `( ) inherit (claude-bridge/claude-opus-5-5)`. It is the only row that names the inherited value: no `(profile default)` row repeating another row, and no `Current Pi model →` label. It comes first in every choice list, before the pinned values.
- Show scroll position as `n of N` or `n–m of N`.
- An empty list says what will appear there, such as `Subagents, tasks, and questions appear here.`, not just that nothing has happened yet.

## Frames

- Text inside a frame keeps a one-column gutter from each border: `│ Items`, `│ Choose model`, `│ › (•) provider/gpt-6-luna`, `│ Status: ready`. This covers list-detail panes, pickers, panels, confirmation text, and wrapped hint rows. `framedGutter(rows, paneWidth)` sets rows in, and content renders at `paneWidth - 2 * FRAME_GUTTER`.
- A right-aligned column, such as elapsed time, also stops one column short of the border or pane divider.

## Glyphs

Each glyph has one meaning, suite-wide. Don't introduce a glyph that isn't listed here, and don't reuse a listed glyph for something else, such as `○` or `✓` for an unanswered tab or a static tab icon. Add a row here in the same change that adds a glyph.

### Status

| Glyph                           | Meaning                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `✓`                             | Succeeded or done                                                                                                                                           |
| `✗`                             | Failed or error                                                                                                                                             |
| `⚠`                             | Warning                                                                                                                                                     |
| `ℹ`                             | Information: an expanded-only note that is neither a problem nor a result                                                                                   |
| `?`                             | Waiting on the user, or on an agent's reply or decision (attention)                                                                                         |
| `⊘`                             | Stopped or cancelled                                                                                                                                        |
| `≈`                             | Uncertain: the outcome could not be confirmed                                                                                                               |
| `‖`                             | Paused                                                                                                                                                      |
| `○`                             | Queued or not started                                                                                                                                       |
| `◌ ◔ ◑ ◕` (animated)            | Starting                                                                                                                                                    |
| `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` (spinner) | Running, on a surface that redraws                                                                                                                          |
| `◒`                             | Stopping                                                                                                                                                    |
| `•`                             | Neutral: no verdict, such as work still running when a saved snapshot was taken (where a spinner would freeze) or a call that returned without pass or fail |

`SUITE_STATUS_GLYPHS`, `managerActivityGlyph`, and `managerNoticeGlyph` own these; use them instead of literals.

### Messages and relationships

| Glyph | Meaning                                                                                     |
| ----- | ------------------------------------------------------------------------------------------- |
| `→`   | Toward: a message sent to its recipient, or a profile routed to its model (`scout → gpt-6`) |
| `←`   | From: a message or reply received                                                           |
| `◎`   | Awaited: the parent agent is waiting on this run                                            |

### Disclosure, selection, and structure

| Glyph         | Meaning                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `▸`           | Collapsed: more is available (a folded tree branch, or `▸ output · C-o Expand`)                                                                                                                                                                                                                          |
| `▾`           | Expanded                                                                                                                                                                                                                                                                                                 |
| `›`           | The focused row in a list, picker, or tree (`LIST_CURSOR`)                                                                                                                                                                                                                                               |
| `[ ]` `[x]`   | Multi-select, unchecked and checked                                                                                                                                                                                                                                                                      |
| `( )` `(•)`   | Single-select, unselected and selected; the dot inside parentheses is part of the marker                                                                                                                                                                                                                 |
| `[x] Stop`    | An action and its one key; the bracketed key is the key that runs it (see [action keys](#action-keys))                                                                                                                                                                                                   |
| `●`           | Unsaved edit                                                                                                                                                                                                                                                                                             |
| `✎`           | Write or edit your own answer (a questionnaire's custom option)                                                                                                                                                                                                                                          |
| `▪` `◦`       | A directory and a file in `find`/`ls` results                                                                                                                                                                                                                                                            |
| `│` `┆`       | In `grep` results, a matching line and a context line                                                                                                                                                                                                                                                    |
| `├─` `└─` `│` | Tree branches, in every tree (Activity, the live widget, codemode calls); structure only. Every tree uses three-column connectors (`├─ `, `│  `). In the Activity manager a branch with children carries its fold marker in place of the second stroke, `├▾ ` or `└▸ `, so glyphs line up with leaf rows |
| `╭╮╰╯`        | Frame corners only, never tree branches                                                                                                                                                                                                                                                                  |
| `…`           | Clipped or omitted text                                                                                                                                                                                                                                                                                  |
| `␊` `␍␊`      | A visible line ending in a diff                                                                                                                                                                                                                                                                          |

### Footer and identity

| Glyph | Meaning                  |
| ----- | ------------------------ |
| `⌂`   | Working directory        |
| `⎇`   | Git branch               |
| `▤`   | Context window usage     |
| `↺`   | Usage limit reset time   |
| `⚡`  | OpenAI fast mode         |
| `⧉`   | The subagent profile set |

Some Code Previews tool headings carry a per-tool icon, such as `📖 read`. The icon names the tool and carries no status.

## Settings

- Every `/<extension> settings` surface opens the same way: a blank row, then the accent title `<Name> settings` at column 1. Pass the title as `openSettingsList`'s string `header`; custom surfaces use `settingsSurfaceHeader`. A nested list or choice list puts its own title and description in the same column.
- Booleans read `on`/`off`. Automatic choices read `auto`. An inherited value reads `inherit (value)`, showing the value that applies, never a bare `inherit` or `parent`, on every surface: rows, choice lists, pickers, and tool output.
- A group's summary shows the short values in effect, inherited or not, most important first, such as `on · 8 running · 256 KB per task`. It never reads `inherit` or `inherit all`.
- A nested list is titled with the label of the row that opened it (`Fast mode`, `Image tool`, `Global`).
- A picker lists an inherited value as its own row, `( ) inherit (low)`, beside the pinned values, never as a `(profile default)` row that repeats one of them. A narrow column drops an inherited model's provider, `inherit (claude-opus-5-5)`, rather than clip it.
- A row's description names the session's value as a sentence: `On in this session.`, `This session uses 1 MB.`
- A setting's label names it without its group, since help, status, and confirmations show it alone. Facts no row shows, such as diagnostics, follow the rows as titled sections of `Name: value` lines.
- A saved change shows at once everywhere it is visible: after a save, every inherited `inherit (value)` label, choice list, and group summary that depends on it reflects the new value within the same invocation. A group whose rows depend on another group's values passes `children` as a function; the shared surface re-derives the rows when the group opens and re-reads every group `summary` each time it draws.
- `createSettingsChoiceSubmenu` puts inherit choices first; owners don't order them. A table cell may drop `inherit (…)` around a value only when keeping it would clip the table's main column.
- An interactive surface posts no notice for a successful change; the row shows the new value. A failed change warns and restores the saved value, even when it settles after the surface closed. A command-line change (`/<ext> settings <id> <value>`) confirms with `Label: value`, led by its scope and followed by a note when it has one: `Global · Running at once: 16 · applies after /reload`.
- Values read as people say them: `Shared checkout`, not `shared-checkout`. Sizes and durations use `formatBytes` and `formatDuration` (`256 KB`, `2s`, `inherit (256 KB)`), and units stay out of labels. Accept the same forms as input, and treat a bare number as the setting's own unit.
- Enter says what it does, and the hint names it:
  - On a boolean it toggles and saves: `Enter Toggle`.
  - On an enum it opens a choice list: `Enter Change`. Moving through the list saves nothing; Enter on a new value saves it, and Esc returns without a change.
  - On a group or a view it opens it: `Enter Open`.
- The shared settings surface infers this from each row: `values` of exactly `on`/`off` toggle, any other `values` open a choice list, and a `submenu` opens. Mark a submenu that picks a value with `kind: "setting"` so it reads `Enter Change`.
- Group related rows instead of prefixing every label with its scope or category. In a settings session's picker, a row with `children` becomes a group row whose nested list saves its rows like top-level ones; `summary` supplies the group's value.
- `/` filters the list. While typing, the hint reads `Type to filter · … · Esc Clear`; once a filter is applied, `Esc Clear` stays until it is cleared.
- A component shown inside a settings surface may implement `settingsHint(expanded)` to supply the single hint line while it is active. Use `settingsListHint` for a component that wraps a pi-tui `SettingsList`.
- Show every row when it fits. Don't hide one row behind a scroll indicator.
- An inline surface ends with a blank row so its hint never touches the footer below it.

## Command help

A bare `/<command>` without its own handler shows one overview, built by `registerExtensionCommand` through `extensionCommandOverview`. Don't hand-write help text.

- The title line reads `/<name>: <description>` at column 1. If it wraps, continuation lines hang two columns in.
- Each subcommand gets one line: a two-column indent, then `/<name> <sub> [args]` padded to the widest entry, two spaces, and a short description, such as `  /code-previews health    Show renderer health`.
- Every line stays within 55 columns, because Pi draws notices one column in and doesn't hang-indent its own wraps. If any aligned line would be wider, the whole list switches to a stacked form: the command on its own line, and its description on the next line indented four columns, wrapping with the same indent. Nothing wraps flush-left at 57 columns.
- Notes such as examples (`overviewNotes`) follow the list verbatim.
- An unknown subcommand warns `Unknown /<name> command: <sub>` and then shows the same overview; `registerExtensionCommand` does this. Never warn with a bare `Usage:` line. When a known subcommand gets wrong arguments, say what is wrong and show the correct form, such as `Add a prompt: /openai image <prompt>`.
- `/<ext> settings help`, `status`, and their errors follow the same rules; the settings shell builds them. Help opens with the overview, then lists each setting as `Label: value (id)` with its description beneath, indented four columns. Status lists the same `Label: value (id)` rows (`settingsStatusText`), never raw `id = value`. A missing value reads `Add a value: /openai settings fast.enabled on|off`, and an unknown setting says where the ids are: `See the setting ids: /openai settings help`.
- Subcommand descriptions also serve as autocomplete text. Pi's autocomplete shows only about 21 columns of description at 57 columns, so keep every autocomplete description within about 20 columns (`Footer settings`, `Show renderer health`), in sentence case, with no trailing period. Put detail in the settings surface or the overview notes, not the description.

## Panels, tables, and long text

- Read-only text uses `TextPanelComponent`. It wraps long lines with a hanging indent, scrolls when it doesn't fit, and closes with `Esc`.
- Put one fact per row as `Label: value`. Split long lists into one row per item.
- Columns use `managerTable`, which drops a column whose cells are all empty so the space goes to columns with content.

## Tool rows

- A collapsed row that has more shows `▸ label · C-o Expand`, naming the configured expand key in the suite key format (`renderExpansionAffordance`). Never hard-code the shortcut or write `ctrl+o to expand`. In border mode the corner shows the whole `▸ label · C-o Expand`.
- The label is a lowercase noun phrase naming what expansion reveals: `error`, `output`, `18 more lines`, `2 more tasks · 1 failed`, `answers`. Never a sentence (`Showing 8 of 10 tasks`) or Title Case (`Error`, `Full answers`). A label standing in for hidden rows names what they hold, including failures.
- Producers declare what expansion reveals and the Code Previews shell draws the affordance, in compact and preview styles alike. A tool row sets `expandLabel` on its compact summary, or `false` when expansion adds nothing; a message sets `expandLabel` on its message presenter. Set it wherever expansion reveals retained content, such as details, prompts, identities, full conversations, or questions, including running calls whose arguments are hidden. Never draw the affordance by hand. See [tool presentation](tool-presentation.md).
- In preview style, a message's body, sent or received, indents two columns under its `Message → name` or `Reply ← name` heading.
- Every workspace tool expands into one layout: the body indents two columns under the heading, labeled sections use the Code Previews style, and technical facts close in a dim `Details` section. Build it with the `pi-code-previews` helpers described in [expanded body layout](tool-presentation.md#expanded-body-layout).
- `Details` lead with the subject's ID, such as the task ID. An agent gets one line, `name: id · profile → provider/model:effort · short facts`, with longer evidence (saved files, the next route candidate, skipped candidates) nested beneath it.
- Compact subjects that don't fit are cut at the end on a word boundary; file paths (`pathSubject`) lose their middle so the file name stays.
- A count heading supplies one combined counter, with shorter aggregate alternatives, never independent counts as alternatives. Join counts with `·`: `1 unavailable · 1 not answering`.
- Each row of a listed result starts with its status glyph. Drop the state word where the glyph or an issue beneath the row already says it. Listed sessions use glyphs by meaning: idle at its prompt `✓`, working when listed `•`, state not confirmed `≈`, unreachable `✗`.
- An empty listing says so once, in the same words: its compact counter and its preview body both read `no active tasks`, and it shows no expansion affordance.
- A collapsed row never wraps a path. Show the display path when it fits, otherwise its file name, shortened in the middle if still too wide; the full path belongs in expanded Details.
- A paused run is stated by its `‖` row; don't add an `ℹ … is paused` issue.
- A list of sessions, agents, or tasks starts each row with the same status glyph on every surface: tool rows, expanded bodies, and command notices.
- A stand-in for hidden rows sits where the rows are hidden and names them: a log's middle `▸ 18 more lines`, a tail's leading `▸ 6 earlier lines`, a list's trailing `▸ 2 more tasks · 1 failed`.
- A started call's collapsed preview row shows its live state (`⠋ Running…`) until it first reports, matching its expanded row.
- A received message's expanded body has no section label; the heading already says what it is.
- In an expanded view, a row of `·`-joined facts wraps with `wrapFacts` and is never clipped; only collapsed rows clip.
- A run's pending question is an attention issue that quotes it, `name asks: …`, on every surface that raises it. A body that also draws the run shows only its state, adding the rest of the question only when the quote was cut.
- A call waiting on the user once its question is on screen sets `waiting` and reads `needs your input`; a call waiting on an agent's reply reads `waiting for reply`. Both show `?`. A queued request shows `○`, and a call that returned because a run paused shows `‖`.

## Time

- Durations: `850ms`, `2.1s`, `1m 25s`.
- Ages: `23s ago`.
- Absolute times come from `formatClockTime(at, now)`: `10:59 PM` on the same local day, otherwise `Nov 3, 10:59 PM`. Never show seconds. A diagnostic read out of context omits `now` and always shows the date.
- Sizes come from `formatBytes`: `512 bytes`, `18 KB`, `1.5 MB`. A trailing `.0` is dropped, as durations drop it.
- Label times whose meaning isn't obvious, such as `resets 10:59 PM`, so they don't read as a clock.
- Reset times are absolute on every surface: `resets 10:59 PM` today, `resets Nov 10, 11:03 PM` otherwise. A countdown (`resets in 6d 22h`) may follow the absolute time as an optional `· in 6d 22h` suffix, or replace it only as a narrow-width fallback where the absolute form doesn't fit, such as the footer's `↺ 2h 3m`.
- Never show epoch numbers.

## Identity

- Show human names first. Add an ID only when two names collide, as a short suffix.
- An agent names its profile and the model it actually runs on: `scout → openai-codex/gpt-6-luna:high ⚡`. The qualifiers after the colon are effort, `⚡` for fast mode, and `(fallback)` or `(override)` when the profile's first choice wasn't used. As a row narrows, live activity gives way first, then the qualifiers, then the profile, then the human title shortens with `…` to about 12 columns; `provider/model`, the elapsed time, the tree branch, and the status glyph stay. Below that floor, the Activity manager moves the identity to a continuation line under the title rather than cut the model. The live widget keeps one line per row, so it shortens the title further and gives up a long status before the model.
- Full IDs, PIDs, cursors, session paths, and raw routing internals belong behind a Technical disclosure.

## Errors and agent text

- Normal states, such as a feature paused for the current model or data that isn't available for this model, are info notices. Warnings are for failures. Every warning names the thing involved (for example, the saved `provider/model`) and its next step, using the real Pi command that fixes it (`/login <provider>`, `/model`, `/thinking`, `/new`, `/btw`), never a vague "choose one" and never a tool only the agent can call.

- A collapsed issue is one short human sentence, such as "File not found", "Rate limited by provider", or "Exited with code 2: missing semicolon". Raw diagnostics, stack frames, and endpoints appear only in expanded detail. See [Issues](tool-presentation.md#issues).
- Agent-authored text, such as reports and results, renders markdown the way Pi renders assistant text. Inline code is styled, not shown with raw backticks.

## Density and width

- State each fact once per surface. Don't repeat titles, statuses, or results.
- Label compact values whose meaning isn't obvious (`cache r163k`, `~1 modified`) when there is room, and fall back to the short form only when narrow.
- Token counts read `23k tokens` wherever there is room, on every surface; the abbreviation `tok` is only a narrow-width fallback. Two surfaces in the same pane never use different words for the same count. Rates read the same way: `~50 tokens/s`, whole numbers from 10 up and one decimal below (`~7.4 tokens/s`).
- Count summaries use the Unicode minus `−` (U+2212): `+4 −2`, `+48 −7`. Diff line prefixes inside diff bodies stay ASCII `+` and `-`.
- A line standing in for rows that don't fit says how many and what they hold, with no separator stranded after the ellipsis: `… 9 more · 1 needs your input · 3 running`.
- A line of facts wraps between whole facts, so no line ends with `·` or `→`. A fact too wide for its line breaks before its `→`, which then leads the continuation: `researcher` above `→ claude-bridge/claude-sonnet-5-5:medium`. Facts after a broken fact keep packing onto its last line.
- Wrapped lines use a hanging indent. Truncation uses `…`. Nothing is cut mid-word without an ellipsis, and a cut at a word boundary closes up before it (`Approve…`, not `Approve …`).

## Waiting and delivery words

One state has one name on every surface, in titles, rows, banners, and counts:

- Work waiting on the user **needs your input** (`1 needs your input`, `Needs your input: Deploy`, the working row's `Needs your input`).
- Work waiting on another agent's reply is **waiting for reply**, in agent tools, lists, Activity, the widget, and parent-contact rows. Never write `asks a question`. A narrow count drops it before shortening it. A waiting row keeps its `?` glyph and elapsed time; where the row is too narrow for both the words and the time, the words give way.
- A message its recipient will read later is **held**, never "holding".
