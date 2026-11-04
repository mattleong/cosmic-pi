import type { Theme } from "@earendil-works/pi-coding-agent";

export const managerTone = {
  session: "success",
  saved: "border",
  identity: "customMessageLabel",
  value: "borderAccent",
} as const;

export const focusedField = (
  theme: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg">>,
  text: string,
): string => {
  const styled = theme.bold(theme.fg("accent", text));
  return theme.bg?.("selectedBg", styled) ?? styled;
};

/** Focused-row cursor for every list, picker, and tree. */
export const LIST_CURSOR = "›";

/** `[x]`/`[ ]` for multi-select and `(•)`/`( )` for single-select rows. */
export const selectionMarker = (mode: "multiple" | "single", selected: boolean): string =>
  mode === "multiple" ? (selected ? "[x]" : "[ ]") : selected ? "(•)" : "( )";
