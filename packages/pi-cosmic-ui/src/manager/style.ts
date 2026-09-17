import type { Theme } from "@earendil-works/pi-coding-agent";

/** Full-screen manager roles use existing tokens so custom themes remain authoritative. */
export const managerTone = {
  session: "success",
  saved: "border",
  identity: "customMessageLabel",
  value: "borderAccent",
} as const;

/** Pass unstyled control text; keep independent status/error fragments outside the field. */
export const focusedField = (
  theme: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg">>,
  text: string,
): string => {
  const styled = theme.bold(theme.fg("accent", text));
  return theme.bg?.("selectedBg", styled) ?? styled;
};
