# Cosmic Pi UI consistency

## Purpose

Cosmic Pi extensions should feel like one Pi-native product. Shared presentation belongs to
`pi-cosmic-ui`; feature packages keep domain policy and host integration. This document is the
contract for new UI and for migrations of existing surfaces.

## Ownership

- **`pi-cosmic-ui`** owns reusable pickers, panel chrome, settings composition, manager
  navigation, status vocabulary, tool-presentation primitives, responsive layout, and the
  composed custom footer.
- **`pi-code-previews`** owns preview mechanics: `withCodePreviewShell`, syntax highlighting,
  diffs, line windows, timing, preview borders/backgrounds, caching, and scheduling.
- **Feature packages** own catalog acquisition, compatibility policy, validation, persistence,
  commands, actions, and domain-specific copy. Shared UI APIs must not become domain facades.
- **`pi-cosmic-core`** owns shared Effect runtime/platform concerns. UI packages must not invent
  parallel runtime abstractions.

## Effect and host boundaries

Effect owns asynchronous work, lifecycle, resources, typed failures, persistence, cancellation,
refresh, and authoritative mutable state. A package-local Effect service publishes a deeply
frozen plain projection at its named host boundary. Shared Cosmic UI receives that projection and
emits plain intents. Effect services, scopes, fibers, mutable references, and live host objects do
not cross extension-package boundaries.

Synchronous TUI rendering, width calculation, formatting, reducers, and key resolution remain
pure TypeScript. Host callbacks remain small named runners that re-enter the owning package's
Effect runtime. Rendering must not start work, persist settings, or acquire resources.

## Pi-native visual language

Use Pi theme tokens, spacing, density, and built-in control conventions. Prefer semantic theme
colors over literal ANSI or RGB values. Footer protocol colors are validated against Pi's
`ThemeColor` vocabulary before reaching render code. Renderers must sanitize untrusted text and
must not let one contribution blank the entire surface.

Do not assert exact borders, colors, icons, or prose in ordinary tests. Protect behavior,
selection identity, information priority, and dimensions.

## Keyboard contract

Shared full-screen surfaces use configured Pi selection bindings plus a modeless Vim layer:

- `j`/`k` and configured or physical Up/Down move.
- `gg`/`G`, Home/End move to the first/last row.
- `C-u`/`C-d` move by half a page; PageUp/PageDown move by a full page.
- `h`/Left goes back or focuses the previous pane; `l`/Right goes forward.
- Enter confirms or opens details; Esc returns one level, then closes.
- `q` closes from navigation mode; `?` toggles expanded help.
- `/` enters explicit search mode. Printable input belongs to the search field only while that
  mode is active. Esc clears and exits search without closing the parent surface.
- A surface-owned printable action takes precedence over configured movement bindings and is not
  advertised as movement in hints.

Destructive confirmation is consistent across managers: the action key or Enter confirms, Esc or
`q` cancels, and unrelated or repeat input leaves the confirmation pending. Identity is reconciled
before execution so stale selections are never acted upon.

## Searchable and model pickers

`pi-cosmic-ui` supplies a generic searchable list reducer/component and a model-specific
projection over it. Model picker rows are plain data: stable id, provider, model id, optional
label/detail, availability, and selection state. Callers retain acquisition, authentication,
compatibility filtering, fallback policy, validation, and persistence.

The model picker starts in the **scoped** catalog supplied by the caller. Tab toggles between
scoped and all authenticated models when the all-model catalog is available. `/` enters search;
`j`/`k` remain navigation keys outside search. Enter selects an enabled row. Esc exits search,
then cancels the picker. Selection remains attached to stable model identity across filtering,
scope changes, and refresh.

This interaction intentionally differs from Pi's type-to-filter `/model` input while retaining its
compact provider/model presentation, theme usage, ranking, and empty-state conventions.

## Panels and settings

Shared panel helpers define Pi-native title, body, notice, hint, frame, and responsive composition.
Managers use the common breakpoints:

- narrow: below 60 columns;
- stacked: 60 through 99 columns;
- wide: 100 columns and above.

Settings commands use the shared settings surface when their workflow is a conventional list or
submenu. Feature-owned dialogs remain feature-owned when a generic surface would hide domain
state or error handling. Existing command names and persisted configuration keys are compatibility
contracts.

## Tool-call presentation

Cosmic UI owns semantic tool presentation: state glyphs, title/status rows, sections, notices,
key/value summaries, and bounded plain output. Feature tools supply plain presentation data and
retain domain-specific decisions. Previewable code, files, commands, and diffs must still use
`withCodePreviewShell`; the semantic layer does not reproduce preview mechanics or wrap tools
owned by another extension.

Tool renderers must separate running, success, warning, failure, and cancellation; preserve useful
partial results; sanitize terminal text; and respect the host-provided width.

## Footer policy

When installed, Cosmic UI is the sole custom-footer owner. Providers publish versioned footer
contributions through the Cosmic UI protocol. A provider must not install a competing custom
footer by default.

When Cosmic UI is absent, Better OpenAI and Better xAI publish compact, sanitized information with
`ctx.ui.setStatus`. Legacy provider replacement footers may remain only as explicit compatibility
options. They must clean up on session replacement and shutdown and must never override Cosmic UI.

## Accessibility and rendering guarantees

Every state conveyed by color also has text or a glyph. Focus, selected state, unavailable state,
loading, warnings, and failures must remain understandable in monochrome terminals. Dynamic text
is sanitized. All renderers accept zero and narrow dimensions without throwing, produce no line
wider than `render(width)`, and clip lower-priority metadata before primary identity or actions.

Exercise responsive UI at widths `20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120`, plus explicit
zero- and one-column edge cases where relevant.

## Compatibility

Migrations preserve command names, tool names, public protocol versions, persisted settings, and
behavioral defaults unless a documented compatibility path says otherwise. Shared APIs expose
plain data and callbacks rather than extension internals. Package `ARCHITECTURE.md` files must be
updated when ownership or lifecycle changes.
