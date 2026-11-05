import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth, RUNNING_SPINNER_FRAMES, SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import { toolRunningLine, toolStatusLine } from "pi-cosmic-ui/tool";
import {
  Container,
  Text,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import type { CompactSummary, CompactSummaryProvider } from "../tools/compact-summary";
import {
  capturePreviewCall,
  type CapturedPreviewCall,
  previewIssueRows,
  previewIssues,
  type PreviewFrames,
  type PreviewIssues,
} from "./preview-issues";
import { getCodePreviewAnimationFrame, withLastComponent } from "./tool-timing";
import { layoutPreviewHeading } from "./preview-heading";
import { recordHeadingSubject } from "./heading-coverage";
import { borderState } from "./bordered-tool-call";
import { renderCompactIssues } from "./compact-issues";
import { compactHold, compactSingleLine, compactStatusIcon } from "./compact-row";
import type { ShellRenderBody } from "./tool-shell";

const BODY_INDENT = "  ";
const GLYPH_HANG = "  ";

/**
 * The preview body an expanded slot wraps. A renderer's next `lastComponent` must be its own prior
 * component, never this slot, whose closures would otherwise chain every earlier render context.
 */
export function unwrapPreviewExpanded(component: Component | undefined): Component | undefined {
  return component instanceof PreviewExpandedSlot ? component.original : component;
}

/**
 * A preview row's expanded slot. With a valid summary and content-only callbacks it draws the
 * shared expanded composition (the call slot leads with the preview heading and issues, indented
 * beneath it); otherwise it draws the tool's own preview body unchanged. The choice is made at
 * draw time, because the summary that decides it can arrive after the slot is built.
 */
class PreviewExpandedSlot implements Component {
  /** The preview body, which the next render receives as `lastComponent` instead of this slot. */
  readonly original: Component;
  private failed = false;
  private drawn: { readonly active: Component; readonly height: number } | undefined;

  private readonly composed: () => Component | undefined;

  constructor(original: Component, composed: () => Component | undefined) {
    this.original = original;
    this.composed = composed;
  }

  render(width: number): string[] {
    let active = this.original;
    let rows: string[] | undefined;
    // A content-only callback that fails to build or draw falls back to the preview body for good.
    if (!this.failed)
      try {
        const composed = this.composed();
        if (composed) {
          rows = composed.render(width);
          active = composed;
        }
      } catch {
        this.failed = true;
      }
    rows ??= this.original.render(width);
    this.drawn = { active, height: rows.length };
    return rows;
  }

  handleMouse(event: TuiMouseEvent) {
    const drawn = this.drawn;
    if (!drawn || event.y < 0 || event.y >= drawn.height) return undefined;
    return drawn.active.handleMouse?.({ ...event, height: drawn.height });
  }

  invalidate(): void {
    this.original.invalidate();
    this.drawn?.active.invalidate();
  }
}

interface ContentCache {
  call?: Component | undefined;
  result?: Component | undefined;
}

const contentCaches = new WeakMap<WeakKey, ContentCache>();

function contentCache(state: WeakKey): ContentCache {
  const existing = contentCaches.get(state);
  if (existing) return existing;
  const created: ContentCache = {};
  contentCaches.set(state, created);
  return created;
}

interface ExpandedSlotInput<TArgs, TDetails, TState extends object> {
  readonly frames: PreviewFrames<TArgs, TDetails, TState>;
  readonly provider: CompactSummaryProvider<TArgs, TDetails, TState>;
  readonly context: ToolRenderContext<TState, TArgs>;
  readonly theme: Theme;
  readonly original: Component;
  readonly content: ShellRenderBody<TArgs, TState>;
}

/**
 * Builds a content-only body once per slot, with its own `lastComponent` chain apart from the
 * original renderer's.
 */
function contentBody<TArgs, TState extends object>(
  slot: "call" | "result",
  context: ToolRenderContext<TState, TArgs>,
  render: ShellRenderBody<TArgs, TState>,
): () => Component {
  let built: Component | undefined;
  let failure: { readonly cause: unknown } | undefined;
  const build = () => {
    const cache = contentCache(context.state);
    built = render(withLastComponent(context, cache[slot]));
    cache[slot] = built;
  };
  // Built with the slot, as compact expansion builds both, so a result body can tell the call body
  // what it already shows before either draws.
  try {
    build();
  } catch (cause) {
    failure = { cause };
  }
  return () => {
    if (failure) throw failure.cause;
    if (!built) build();
    return built ?? new Container();
  };
}

/**
 * The row's own collapsed preview heading, so a row reads the same collapsed and expanded, or a
 * heading built from the summary when the tool's body can't supply one.
 */
function headingRows(
  own: CapturedPreviewCall | undefined,
  title: string,
  summary: CompactSummary,
  state: WeakKey,
  theme: Theme,
  width: number,
): string[] {
  const rows = own?.heading(width);
  // A preview heading wraps rather than clips, so it shows the whole subject.
  if (rows) {
    recordHeadingSubject(state, true);
    return rows;
  }
  const { text, subjectComplete } = layoutPreviewHeading(title, summary, true, theme);
  recordHeadingSubject(state, subjectComplete);
  return new Text(text, 0, 0).render(width);
}

/** Runs a capture outside the row's border slot, so its expand hint labels no border. */
function outsideBorderSlot<T>(context: { readonly state: unknown }, capture: () => T): T {
  const border = borderState(context);
  const slot = border.codePreviewBorderCurrentSlot;
  border.codePreviewBorderCurrentSlot = undefined;
  try {
    return capture();
  } finally {
    border.codePreviewBorderCurrentSlot = slot;
  }
}

/** Each expanded row's collapsed result body, which its call slot reads to keep what it shows. */
const collapsedResults = new WeakMap<WeakKey, (width: number) => readonly string[]>();

function captureCollapsedResult<TArgs, TState extends object>(
  context: ToolRenderContext<TState, TArgs>,
  render: ShellRenderBody<TArgs, TState>,
): void {
  let body: Component;
  try {
    body = outsideBorderSlot(context, () =>
      render({ ...context, expanded: false, lastComponent: undefined }),
    );
  } catch {
    collapsedResults.delete(context.state);
    return;
  }
  let drawn: { readonly width: number; readonly rows: readonly string[] } | undefined;
  collapsedResults.set(context.state, (width) => {
    if (drawn?.width !== width) {
      let rows: readonly string[];
      try {
        rows = body.render(width);
      } catch {
        rows = [];
      }
      drawn = { width, rows };
    }
    return drawn.rows;
  });
}

const plainText = (rows: readonly string[]): string =>
  Str.toLowerCase(Str.replace(/\s+/gu, " ")(stripTerminalControls(Arr.join(rows, " "))));
const escapeRegExp = Str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether rows state the fact as whole words, even across a wrap, regardless of case and of quotes
 * around it, as an answer listed in a body states the quoted answer.
 */
function statesFact(rows: readonly string[], fact: string): boolean {
  const said = Str.toLowerCase(Str.replace(/^["'“‘«]+|["'”’»]+$/gu, "")(Str.trim(fact)));
  return (
    said !== "" &&
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(said)}(?:$|[^\\p{L}\\p{N}])`, "u").test(
      plainText(rows),
    )
  );
}

/**
 * Lowercase state words begin a sentence capitalized; identifiers, paths, and model names, whose
 * first word holds other characters, stay as written.
 */
const sentenceCase = (text: string): string =>
  /^\p{Ll}+(?:\s|$)/u.test(text)
    ? `${Str.toUpperCase(Str.slice(0, 1)(text))}${Str.slice(1)(text)}`
    : text;

interface StatusInput {
  readonly value: PreviewIssues;
  /** Everything the collapsed row draws. */
  readonly collapsed: readonly string[];
  /** The expanded heading, issues, and bodies. */
  readonly expanded: readonly string[];
  /** The expanded issue rows. */
  readonly issues: readonly string[];
  readonly frame: number;
  readonly theme: Theme;
}

/**
 * The fact a compact heading shows beside its glyph, its first counter or else its first metadata:
 * each ` · ` part the collapsed row states and the expanded row doesn't.
 */
function keptFact({ value, collapsed, expanded }: StatusInput): string | undefined {
  const { summary } = value;
  const fact = compactSingleLine(summary?.counters?.[0] ?? summary?.metadata?.[0] ?? "");
  const kept = Arr.filter(
    Arr.map(Str.split(fact, " · "), Str.trim),
    (part) => part !== "" && statesFact(collapsed, part) && !statesFact(expanded, part),
  );
  return kept.length > 0 ? sentenceCase(Arr.join(kept, " · ")) : undefined;
}

/**
 * Whether a cancelled row's collapsed `Cancelled`, drawn where it has no issues, gives way to
 * issues only an expanded row shows, such as information.
 */
function cancelledLineReplaced({ value, theme }: StatusInput, width: number): boolean {
  const shown = (expanded: boolean) =>
    renderCompactIssues(value.issues, theme, width, expanded, "").length > 0;
  return value.cancelled && !shown(false) && shown(true);
}

/** A live or held state, and the word and glyphs by which a heading or body already states it. */
const HELD_STATES = {
  running: { word: "running", glyphs: RUNNING_SPINNER_FRAMES },
  waiting: { word: "waiting", glyphs: [SUITE_STATUS_GLYPHS.waiting] },
  queued: { word: "queued", glyphs: [SUITE_STATUS_GLYPHS.queued] },
  paused: { word: "paused", glyphs: [SUITE_STATUS_GLYPHS.paused] },
} as const;
type HeldState = keyof typeof HELD_STATES;

// Indentation, tree branches, and box rules before a row's own text.
const ROW_LEAD = /^[\s│├└┌┬─╭╰]+/u;

/**
 * Whether a row states the held state: it begins with the state's glyph, opens with the state word
 * capitalized (`Paused by the user`) or a count of it (`1 paused`, `0/2 running`), or holds a later
 * `·`-separated fact that begins with the word (`auth-review · waiting for reply`). Prose that only
 * mentions the word, even at the start of a wrapped line, doesn't state the row's state.
 */
function statesHeld(rows: readonly string[], state: HeldState): boolean {
  const { word, glyphs } = HELD_STATES[state];
  const end = "(?:$|[^\\p{L}\\p{N}])";
  const opening = new RegExp(`^(?:${sentenceCase(word)}|\\d+(?:/\\d+)? ${word})${end}`, "u");
  const fact = new RegExp(`^(?:\\d+(?:/\\d+)? )?${word}${end}`, "iu");
  return Arr.some(rows, (row) => {
    const plain = Str.replace(ROW_LEAD, "")(stripTerminalControls(row));
    if (Arr.some(glyphs, (glyph) => Str.startsWith(`${glyph} `)(plain))) return true;
    const [first, ...rest] = Str.split(plain, " · ");
    return opening.test(first) || Arr.some(rest, (segment) => fact.test(Str.trim(segment)));
  });
}

/**
 * A preview heading carries no status glyph, so an expanded preview row states the row's state on
 * its own line, which exists only so the state never disappears on expansion. Issues carry state,
 * so a row that shows any has no line, except a cancelled row whose collapsed `Cancelled` they
 * replace. A live, waiting, queued, or paused row says so unless its heading or body already does;
 * a cancelled, unconfirmed, or other settled row keeps the fact its collapsed row states and the
 * expanded row doesn't. The glyph is the state's own: a settled receipt is never marked as a
 * warning.
 */
function previewStatusRows(input: StatusInput, width: number): string[] {
  const { value, theme, issues, expanded } = input;
  if (issues.length > 0 && !cancelledLineReplaced(input, width)) return [];
  const { status, summary } = value;
  const metadata = sentenceCase(compactSingleLine(summary?.metadata?.[0] ?? ""));
  // A live or held state the heading or body already states needs no line. A phrase such as
  // `Needs your input` counts wherever it appears; the bare state word only as `statesHeld` finds it.
  const unstated = (state: HeldState, text: string) =>
    statesHeld(expanded, state) ||
    (Str.toLowerCase(text) !== HELD_STATES[state].word && statesFact(expanded, text))
      ? undefined
      : text;
  const said = (state: HeldState, fallback: string) => unstated(state, metadata || fallback);
  const hold = status === "pending" || status === "running" ? compactHold(summary) : undefined;
  const line = Match.value(status).pipe(
    Match.when(
      () => hold === "waiting",
      () => {
        const text = said("waiting", "Waiting for reply");
        return text && toolStatusLine(theme, "waiting", text);
      },
    ),
    Match.when(
      () => hold === "queued",
      () => {
        const text = said("queued", "Queued");
        return text && theme.fg("muted", `${SUITE_STATUS_GLYPHS.queued} ${text}`);
      },
    ),
    Match.when("running", () =>
      unstated("running", "running") === undefined
        ? undefined
        : toolRunningLine(theme, input.frame),
    ),
    Match.when("pending", () => undefined),
    Match.when("queued", () => {
      const text = said("queued", "Queued");
      return text && theme.fg("muted", `${SUITE_STATUS_GLYPHS.queued} ${text}`);
    }),
    Match.when("paused", () => {
      const text = said("paused", "Paused");
      return text && toolStatusLine(theme, "paused", text);
    }),
    Match.when("cancelled", () => {
      const text = keptFact(input) ?? (statesFact(expanded, "cancelled") ? undefined : "Cancelled");
      return text && toolStatusLine(theme, "stopped", text);
    }),
    Match.when("uncertain", () => {
      const text =
        keptFact(input) ??
        (statesFact(expanded, "unconfirmed") ? undefined : "Outcome unconfirmed");
      return text && theme.fg("warning", `≈ ${text}`);
    }),
    Match.orElse((settled) => {
      const text = keptFact(input);
      // Without issues, a warning outcome has nothing the line could be warning about.
      const glyph = settled === "warning" ? "returned" : settled;
      return (
        text &&
        `${compactStatusIcon(glyph, theme, input.frame, false, summary?.messageIcon)} ${theme.fg("muted", text)}`
      );
    }),
  );
  if (!line) return [];
  // Continuation rows hang beneath the text, past the glyph.
  return Arr.map(
    wrapTextWithAnsi(line, Math.max(1, width - BODY_INDENT.length - GLYPH_HANG.length)),
    (row, index) => clipToWidth(`${BODY_INDENT}${index === 0 ? "" : GLYPH_HANG}${row}`, width, ""),
  );
}

/** The call slot: preview heading, then issues and the content-only call body beneath it. */
export function previewExpandedCall<TArgs, TDetails, TState extends object>(
  input: ExpandedSlotInput<TArgs, TDetails, TState> & {
    readonly title: string;
    readonly heading: ShellRenderBody<TArgs, TState>;
  },
): Component {
  const { frames, provider, context, theme, original, title } = input;
  const body = contentBody("call", context, input.content);
  // Outside a border slot, the collapsed body draws its own hints instead of labeling the border.
  const own = outsideBorderSlot(context, () => capturePreviewCall(input.heading, context));
  return new PreviewExpandedSlot(original, () => {
    const current = frames.latest(context);
    const value = previewIssues(frames, provider, current);
    const { summary } = value;
    if (!current.expanded || !summary) return undefined;
    const content = body();
    return {
      render: (width) => {
        const heading = headingRows(own, title, summary, current.state, theme, width);
        const issues = previewIssueRows(value, theme, width, true, BODY_INDENT);
        const rows = content.render(width);
        const result = contentCache(current.state).result?.render(width) ?? [];
        const status = previewStatusRows(
          {
            value,
            collapsed: [
              ...(own?.rows(width) ?? heading),
              ...previewIssueRows(value, theme, width, false, ""),
              ...(collapsedResults.get(current.state)?.(width) ?? []),
            ],
            expanded: [...heading, ...issues, ...rows, ...result],
            issues,
            frame: getCodePreviewAnimationFrame(current),
            theme,
          },
          width,
        );
        return [...heading, ...status, ...issues, ...rows];
      },
      handleMouse: (event) => content.handleMouse?.(event),
      invalidate: () => content.invalidate(),
    };
  });
}

/** The result slot: the content-only result body, with any timing line at the body column. */
export function previewExpandedResult<TArgs, TDetails, TState extends object>(
  input: ExpandedSlotInput<TArgs, TDetails, TState> & {
    readonly timing: string | undefined;
    /** The tool's own result body, drawn collapsed so the call slot can keep what it shows. */
    readonly collapsed: ShellRenderBody<TArgs, TState>;
  },
): Component {
  const { frames, provider, context, theme, original, timing } = input;
  const body = contentBody("result", context, input.content);
  captureCollapsedResult(context, input.collapsed);
  return new PreviewExpandedSlot(original, () => {
    const current = frames.latest(context);
    if (!current.expanded || !previewIssues(frames, provider, current).summary) return undefined;
    const content = body();
    return {
      render: (width) => [
        ...content.render(width),
        ...(timing ? [clipToWidth(`${BODY_INDENT}${theme.fg("muted", timing)}`, width, "")] : []),
      ],
      handleMouse: (event) => content.handleMouse?.(event),
      invalidate: () => content.invalidate(),
    };
  });
}
