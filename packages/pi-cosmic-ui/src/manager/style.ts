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
