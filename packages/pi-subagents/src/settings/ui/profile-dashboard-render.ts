import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";
import { framedFill, framedScreen } from "pi-cosmic-ui/manager/list-detail-shell";
import { profileFrame, profileTone } from "./profile-style.ts";

/** Framed children share the dashboard's outer border; plain dialogs sit inside it. */
export const profileDashboardChildHeight = (height: number, framed = true): number =>
  Math.max(0, Math.floor(height) - (framed ? 3 : 4));

export function renderProfileDashboard(
  state: {
    readonly tab: "session" | "saved";
    readonly message: string;
    readonly blocked: boolean;
    readonly busy: boolean;
    readonly rows: readonly string[];
    readonly framedChild: boolean;
  },
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  const inner = Math.max(0, width - 2);
  const frame = profileFrame(options.theme);
  const tab = (id: "session" | "saved", label: string) => {
    const active = state.tab === id;
    const text = `${active ? "[" : " "}${label}${active ? "]" : " "}`;
    return options.theme.fg(
      profileTone[id],
      active ? options.theme.bold(options.theme.underline(text)) : text,
    );
  };
  const header = ` ${tab("session", "Current Session")}  ${tab("saved", "Saved profiles")}`;
  const status = state.blocked
    ? "Close and reopen to continue editing."
    : state.message || (state.busy ? "Saving…" : "");
  // Strip only the owned child's border cells, preserving styles and cursor markers.
  const child = state.framedChild
    ? state.rows.map((line) => sliceByColumn(line, 1, inner))
    : state.rows;
  const footer = state.framedChild && child.length > 1 ? child.at(-1)! : "";
  const body = state.framedChild && child.length > 1 ? child.slice(0, -1) : child;
  return framedScreen(frame, {
    width,
    height,
    top: "",
    bottom: footer,
    body: (bodyHeight) => {
      const rows = framedFill(
        frame,
        [header, options.theme.fg(state.blocked ? "error" : "muted", status), ...body],
        bodyHeight,
        inner,
      );
      if (state.framedChild && body.length > 0 && bodyHeight > 2) {
        rows[2] = `${frame.outer("├")}${body[0]}${frame.outer("┤")}`;
        // The child owns pane-focus styling on its side borders.
        for (let index = 1; index < body.length && index + 2 < bodyHeight; index += 1)
          rows[index + 2] = state.rows[index]!;
      }
      return rows;
    },
  });
}
