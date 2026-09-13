import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function renderProfileDashboard(
  state: {
    readonly tab: "session" | "saved";
    readonly message: string;
    readonly blocked: boolean;
    readonly busy: boolean;
    readonly rows: readonly string[];
  },
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] {
  const tab = (id: "session" | "saved", label: string) =>
    options.theme.fg(
      state.tab === id ? "accent" : "muted",
      `${state.tab === id ? "[" : " "}${label}${state.tab === id ? "]" : " "}`,
    );
  const header = `  ${tab("session", "Current Session")}  ${tab("saved", "Saved profiles")}`;
  const status = state.blocked
    ? "Close and reopen to continue editing."
    : state.message || (state.busy ? "Saving…" : "");
  return [header, status, ...state.rows]
    .slice(0, Math.max(0, options.height))
    .map((line) => truncateToWidth(line, Math.max(0, options.width)));
}
