import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth, SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
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
import { compactSingleLine, compactStatusIcon } from "./compact-row";
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
const words = (text: string): ReadonlyArray<string> =>
  Option.getOrElse(Str.match(/[\p{L}\p{N}]+/gu)(text), (): ReadonlyArray<string> => []);
const escapeRegExp = Str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const sameWords = (text: string, fact: string): boolean =>
  Str.includes(` ${Arr.join(words(fact), " ")} `)(` ${Arr.join(words(text), " ")} `);

/**
 * Whether rows state the fact as whole words, regardless of case and of quotes around it, as an
 * answer listed in a body states the quoted answer.
 */
function statesFact(rows: readonly string[], fact: string): boolean {
  const said = Str.toLowerCase(Str.replace(/^["'“‘«]+|["'”’»]+$/gu, "")(fact));
  return (
    said !== "" &&
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(said)}(?:$|[^\\p{L}\\p{N}])`, "u").test(
      plainText(rows),
    )
  );
}

/**
 * Whether the rows hold the fact: its words in order, even across a wrap, or every word of it on
 * one row, which may phrase it its own way, as `Removed 3 completed tasks` does `3 removed`.
 */
function mentionsFact(rows: readonly string[], fact: string): boolean {
  const lower = Str.toLowerCase(fact);
  const factWords = words(lower);
  if (factWords.length === 0) return false;
  return (
    sameWords(plainText(rows), lower) ||
    Arr.some(rows, (row) => {
      const said = new Set(words(plainText([row])));
      return Arr.every(factWords, (word) => said.has(word));
    })
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
  /** The expanded heading, issues, and bodies, whose facts the status line doesn't repeat. */
  readonly expanded: readonly string[];
  /** The expanded issue rows. */
  readonly issues: readonly string[];
  readonly frame: number;
  readonly theme: Theme;
}

/**
 * The fact a compact row's heading shows beside its glyph, its first counter or else its first
 * metadata, keeping each ` · ` part that the collapsed preview shows and the rest of the expanded
 * row doesn't.
 */
function keptFact({ value, collapsed, expanded }: StatusInput): string | undefined {
  const { summary } = value;
  const fact = compactSingleLine(summary?.counters?.[0] ?? summary?.metadata?.[0] ?? "");
  const kept = Arr.filter(
    Arr.map(Str.split(fact, " · "), Str.trim),
    (part) => part !== "" && mentionsFact(collapsed, part) && !statesFact(expanded, part),
  );
  return kept.length > 0 ? sentenceCase(Arr.join(kept, " · ")) : undefined;
}

/**
 * Whether the collapsed row says `Cancelled` where it would show issues, while the expanded row
 * shows issues collapsed rows leave out, such as information, in its place.
 */
function cancelledLineReplaced({ value, theme }: StatusInput, width: number): boolean {
  const shown = (expanded: boolean) =>
    renderCompactIssues(value.issues, theme, width, expanded, "").length > 0;
  return value.cancelled && !shown(false) && shown(true);
}

/**
 * A preview heading carries no status glyph, and content-only bodies leave state to the heading, so
 * an expanded preview row states its state on its own line. A running, waiting, held, stopped, or
 * unconfirmed row always says so unless an issue already does. Otherwise, a settled row keeps the
 * state fact its collapsed preview shows but the expanded row would drop, such as a task's
 * `running`, after the compact row's status glyph. A call that hasn't started needs no line.
 */
function previewStatusRows(input: StatusInput, width: number): string[] {
  const { value, theme, issues } = input;
  const { status, summary } = value;
  const metadata = sentenceCase(compactSingleLine(summary?.metadata?.[0] ?? ""));
  const said = (fallback: string) => metadata || fallback;
  const live = status === "pending" || status === "running";
  const quietIssues = issues.length === 0;
  const line = Match.value(status).pipe(
    Match.when(
      () => live && summary?.waiting === true,
      () => toolStatusLine(theme, "waiting", said("Waiting for a reply")),
    ),
    Match.when("running", () => toolRunningLine(theme, input.frame)),
    Match.when("pending", () => undefined),
    Match.when("queued", () =>
      theme.fg("muted", `${SUITE_STATUS_GLYPHS.queued} ${said("Queued")}`),
    ),
    Match.when("paused", () => toolStatusLine(theme, "paused", said("Paused"))),
    Match.when("cancelled", () => {
      const text =
        keptFact(input) ??
        (quietIssues || cancelledLineReplaced(input, width) ? "Cancelled" : undefined);
      return text === undefined ? undefined : toolStatusLine(theme, "stopped", text);
    }),
    Match.when("uncertain", () => {
      const text = keptFact(input) ?? (quietIssues ? "Outcome unconfirmed" : undefined);
      return text === undefined ? undefined : theme.fg("warning", `≈ ${text}`);
    }),
    Match.orElse((settled) => {
      const text = keptFact(input);
      return text === undefined
        ? undefined
        : `${compactStatusIcon(settled, theme, input.frame, false, summary?.messageIcon)} ${theme.fg("muted", text)}`;
    }),
  );
  if (line === undefined) return [];
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
