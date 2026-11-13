import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  clipToWidth,
  INLINE_SEPARATOR,
  joinInline,
  managerNoticeColor,
  managerNoticeGlyph,
  type ManagerNoticeKind,
} from "pi-cosmic-ui/manager";
import {
  FRAME_GUTTER,
  framedFill,
  framedGutter,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import type { ProfileSettingsInspection, ProfileWorkspaceTarget } from "../profile-route-editor.ts";
import { qualifiedProfileSetLabel } from "./profile-set-picker-model.ts";
import { sessionChangedProfiles } from "../../profiles/session-overrides.ts";
import { countLabel } from "pi-cosmic-core/display";

/**
 * A decision a pane keeps in view: `text` (styled, may hold line breaks) wraps in a band above the
 * bottom border, or lines already fitted to it, such as a name input that must not wrap; `hint`
 * names its keys in the border, such as `Enter Delete · Esc Cancel`.
 */
export interface DashboardPrompt {
  readonly text: string | ReadonlyArray<string>;
  readonly hint: string;
}

/** The status row's content: a transient message, or the tab's standing context (`plain`). */
export interface DashboardStatus {
  readonly kind: Exclude<ManagerNoticeKind, "attention"> | "plain";
  readonly text: string;
}

type DashboardTab = "session" | "saved";

/** Text width between the dashboard frame's gutters. */
export const profileDashboardTextWidth = (width: number): number =>
  Math.max(1, Math.floor(width) - 2 - 2 * FRAME_GUTTER);

/** The most facts, in order, that fit `width`, so a narrow row drops its trailing context first. */
const fittedFacts = (facts: ReadonlyArray<string>, width: number): string =>
  Option.getOrElse(
    Arr.findFirst(
      Arr.makeBy(facts.length, (dropped) => joinInline(facts.slice(0, facts.length - dropped))),
      (line) => visibleWidth(line) <= width,
    ),
    () => facts[0] ?? "",
  );

// Narrower than this, `Based on …` gives way to the count of changed profiles alone.
const MIN_BASE_WIDTH = 16;

const originLabel = (inspection: ProfileSettingsInspection): string => {
  const origin = inspection.session.baseline.origin;
  if (origin.scope === "builtin") return "built-in profiles";
  if (origin.name === undefined) return `an invalid ${origin.scope} default`;
  const label = qualifiedProfileSetLabel({ scope: origin.scope, name: origin.name });
  return origin.invalid === true ? `${label} (invalid)` : label;
};

/**
 * Each tab's standing context. The session names the set it is based on and how many profiles it
 * changes from it; a saved set's editor names the set it writes to; the library says sets stay
 * separate until used.
 */
export const profileDashboardContext = (
  inspection: ProfileSettingsInspection,
  editing: ProfileWorkspaceTarget | undefined,
  width: number,
  /** Following a message, the count of changed profiles leads, since it is what just changed. */
  following = false,
): string => {
  if (editing?.kind === "session") {
    const changed = sessionChangedProfiles(inspection.session).length;
    const changes = changed ? `${countLabel(changed, "profile")} changed` : "no changes";
    const base = `${following ? "based" : "Based"} on ${originLabel(inspection)}`;
    const facts = following
      ? [changes, base]
      : [base, changes, "edits apply to later launches, not active runs"];
    const fitted = fittedFacts(facts, width);
    if (visibleWidth(fitted) <= width && fitted !== base) return fitted;
    // The count matters more than the set's whole name, which gives way first.
    const room = width - visibleWidth(changes) - INLINE_SEPARATOR.length;
    if (room < MIN_BASE_WIDTH) return changes;
    const shortened = clipToWidth(base, room, "…");
    return joinInline(following ? [changes, shortened] : [shortened, changes]);
  }
  if (following) return editing ? fittedFacts(["this session is unchanged"], width) : "";
  if (editing)
    return fittedFacts(
      [
        `Editing ${qualifiedProfileSetLabel(editing.set)}`,
        "each change saves to this set",
        "this session is unchanged",
      ],
      width,
    );
  const full = "Saved sets stay separate from this session until you use one.";
  return visibleWidth(full) <= width ? full : "Sets stay separate until you use one.";
};

/**
 * The status row, one line under the top border; a warning or error that doesn't fit takes a
 * second line rather than lose its words.
 */
export const profileDashboardStatusLines = (
  status: DashboardStatus,
  theme: Theme,
  width: number,
): ReadonlyArray<string> => {
  const room = Math.max(1, width);
  if (status.kind === "plain") return [theme.fg("muted", clipToWidth(status.text, room, "…"))];
  const glyph = status.kind === "info" ? "" : `${managerNoticeGlyph(status.kind)} `;
  const color = managerNoticeColor(status.kind);
  const text = `${glyph}${status.text}`;
  if (status.kind === "success" || status.kind === "info")
    return [theme.fg(color, clipToWidth(text, room, "…"))];
  const lines = wrapTextWithAnsi(text, room);
  const shown = lines.slice(0, 2);
  if (lines.length > 2) shown[1] = `${clipToWidth(shown[1] ?? "", room - 1, "")}…`;
  return Arr.map(shown, (line) => theme.fg(color, line));
};

const horizontalRule = (width: number) => Fn.pipe("─", Str.repeat(Math.max(0, width)));

/**
 * The dashboard's frame: the tabs in the top border (the current one highlighted, the other
 * muted), the status row, then the current pane's framed rows, whose top border becomes a divider
 * and whose bottom border, with its key hints, closes the frame.
 */
export function renderProfileDashboard(
  state: {
    readonly tab: DashboardTab;
    readonly status: ReadonlyArray<string>;
    readonly rows: ReadonlyArray<string>;
  },
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width < 4 || height === 0)
    return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(width)));
  const inner = width - 2;
  const { theme } = options;
  const frame = listDetailFrame(theme);
  const tab = (id: DashboardTab, label: string) =>
    state.tab === id
      ? theme.bg("selectedBg", theme.fg("text", ` ${label} `))
      : theme.fg("muted", ` ${label} `);
  const tabs = clipToWidth(
    `${tab("session", "Current session")} ${tab("saved", "Saved profiles")}`,
    Math.max(0, inner - 1),
    "",
  );
  const top = `${frame.outer("╭─")}${tabs}${frame.outer(
    `${horizontalRule(inner - 1 - visibleWidth(tabs))}╮`,
  )}`;
  const status = framedFill(frame, framedGutter(state.status, inner), state.status.length, inner);
  const [childTop, ...childRest] = state.rows;
  const divider =
    childTop === undefined
      ? []
      : [`${frame.outer("├")}${sliceByColumn(childTop, 1, inner)}${frame.outer("┤")}`];
  const rows = [top, ...status, ...divider, ...childRest].slice(0, height);
  return [...rows, ...framedFill(frame, [], height - rows.length, inner)];
}
