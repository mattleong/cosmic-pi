import type { Theme } from "@earendil-works/pi-coding-agent";
import { framedFill, framedScreen, listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

export const renderProfileSetSaveForm = (
  state: {
    readonly scope: "global" | "project";
    readonly section: "destination" | "name" | "save";
    readonly nameRows: ReadonlyArray<string>;
    readonly projectTrusted: boolean;
    readonly message?: string | undefined;
  },
  options: Pick<SearchableSelectHostOptions, "keybindingLabel"> & {
    readonly theme: Theme;
    readonly width: number;
    readonly height: number;
    readonly sectionKeyLabel?: string | undefined;
  },
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width < 4 || height === 0) return Array.from({ length: height }, () => " ".repeat(width));
  const label = options.keybindingLabel ?? ((_id, fallback) => fallback);
  const frame = listDetailFrame(options.theme);
  const destination = `${state.section === "destination" ? ">" : " "} Destination: ${state.scope === "project" ? "Project · For this project" : "Global · For all projects"}${state.projectTrusted ? ` (${label("tui.select.up", "↑")}/${label("tui.select.down", "↓")} change)` : " (Project requires trust)"}`;
  const name = [`${state.section === "name" ? ">" : " "} Name`, ...state.nameRows];
  const save = `${state.section === "save" ? ">" : " "} [Save Current Session]`;
  return framedScreen(frame, {
    width,
    height,
    top: " Save these profiles as a set · Source: Current Session ",
    bottom: `${options.sectionKeyLabel ?? "Tab"} Section · ${label("tui.select.confirm", "Enter")} ${state.section === "destination" ? "Name" : "Save"} · ${label("tui.select.cancel", "Esc")} Cancel`,
    body: (bodyHeight) => {
      const rows =
        bodyHeight < 5
          ? [
              state.section === "destination"
                ? destination
                : state.section === "save"
                  ? save
                  : (state.nameRows[0] ?? "Name"),
              ...(state.message ? [state.message] : []),
            ]
          : [
              destination,
              ...name,
              save,
              state.message ??
                "Copies all seven profiles. Does not apply the set or change the default.",
            ];
      return framedFill(frame, rows.slice(0, bodyHeight), bodyHeight, width - 2);
    },
  });
};
