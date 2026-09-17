import type { Theme } from "@earendil-works/pi-coding-agent";
import { framedWideRows, listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";

export const profileTone = {
  ...managerTone,
  profile: managerTone.identity,
  model: managerTone.value,
} as const;

export const focusedProfileField = focusedField;

export const profileFrame = (theme: Theme, focused = false) =>
  listDetailFrame(theme, focused ? "list" : undefined);

/** Profile editors retain their pane policy while sharing manager geometry and edge styling. */
export const profilePaneRows = (
  theme: Theme,
  options: {
    readonly left: ReadonlyArray<string>;
    readonly right: ReadonlyArray<string>;
    readonly height: number;
    readonly listWidth: number;
    readonly detailWidth: number;
    readonly focused: "list" | "detail";
  },
): string[] => framedWideRows(listDetailFrame(theme, options.focused), options);
