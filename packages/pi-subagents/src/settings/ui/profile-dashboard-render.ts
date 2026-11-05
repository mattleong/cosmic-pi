import * as Arr from "effect/Array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { managerTabs } from "pi-cosmic-ui/manager";
import {
  FRAME_GUTTER,
  framedFill,
  framedGutter,
  framedScreen,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";

/** The width an unframed child, such as a dialog, renders at inside the dashboard's gutters. */
export const profileDashboardChildWidth = (width: number): number =>
  Math.max(0, Math.floor(width) - 2 - 2 * FRAME_GUTTER);

export const profileDashboardChildHeight = (height: number, framed = true): number =>
  Math.max(0, Math.floor(height) - (framed ? 3 : 4));

export function renderProfileDashboard(
  state: {
    readonly tab: "session" | "saved";
    readonly message: string;
    readonly blocked: boolean;
    readonly busy: boolean;
    readonly rows: readonly string[];
    /** A framed child draws its own frame, whose bottom border becomes the dashboard's. */
    readonly framedChild: boolean;
    /** The bottom border's hint for an unframed child, such as a dialog. */
    readonly border?: string | undefined;
  },
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  const inner = Math.max(0, width - 2);
  const frame = listDetailFrame(options.theme);
  // Tabs read like the questionnaire's: the current one highlighted, the others muted.
  const tab = (id: "session" | "saved", label: string) =>
    state.tab === id
      ? options.theme.bg("selectedBg", options.theme.fg("text", ` ${label} `))
      : options.theme.fg("muted", ` ${label} `);
  const header = managerTabs(
    [tab("session", "Current session"), tab("saved", "Saved profiles")],
    state.tab === "session" ? 0 : 1,
    inner,
  );
  const status = state.blocked
    ? "Close and reopen to continue editing."
    : state.message || (state.busy ? "Saving…" : "");
  const child = state.framedChild
    ? Arr.map(state.rows, (line) => sliceByColumn(line, 1, inner))
    : framedGutter(state.rows, inner);
  const footer =
    state.framedChild && child.length > 1 ? (child.at(-1) ?? "") : (state.border ?? "");
  const body = state.framedChild && child.length > 1 ? child.slice(0, -1) : child;
  return framedScreen(frame, {
    width,
    height,
    top: "",
    bottom: footer,
    body: (bodyHeight) => {
      const rows = framedFill(
        frame,
        [
          header,
          ...framedGutter([options.theme.fg(state.blocked ? "error" : "muted", status)], inner),
          ...body,
        ],
        bodyHeight,
        inner,
      );
      const firstRow = body[0];
      if (state.framedChild && firstRow !== undefined && bodyHeight > 2) {
        rows[2] = `${frame.outer("├")}${firstRow}${frame.outer("┤")}`;
        for (let index = 1; index < body.length && index + 2 < bodyHeight; index += 1)
          rows[index + 2] = state.rows[index] ?? "";
      }
      return rows;
    },
  });
}
