import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import type { ProfileSetPickerEntry } from "./profile-set-picker-model.ts";

export interface ProfileSetPickerRenderState {
  readonly entries: ReadonlyArray<ProfileSetPickerEntry>;
  readonly selectedIndex: number;
  readonly query: string;
  readonly searching: boolean;
  readonly reloadRequired: boolean;
  readonly sessionOverrideCount: number;
  readonly activeSelectionLabel?: string | undefined;
  readonly savedSelectionLabel?: string | undefined;
  readonly message?: { readonly kind: "info" | "warning" | "error"; readonly text: string };
  readonly pendingConfirmation?:
    | { readonly kind: "use"; readonly label: string; readonly reloadRequired: boolean }
    | { readonly kind: "delete"; readonly label: string }
    | undefined;
}

const pad = (value: string, width: number): string => {
  const text = truncateToWidth(value, Math.max(0, width), "");
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
};

const windowStart = (length: number, selected: number, visible: number): number =>
  Math.max(0, Math.min(Math.max(0, length - visible), selected - Math.floor(visible / 2)));

export const renderProfileSetPicker = (
  state: ProfileSetPickerRenderState,
  options: { readonly theme: Theme; readonly width: number; readonly height: number },
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const theme = options.theme;
  const inner = width - 2;
  const status = state.reloadRequired
    ? theme.fg("warning", "saved changes pending reload")
    : state.sessionOverrideCount > 0
      ? theme.fg(
          "accent",
          `${state.sessionOverrideCount} session override${state.sessionOverrideCount === 1 ? "" : "s"}`,
        )
      : theme.fg("muted", "ready");
  const title = truncateToWidth(` /subagents profiles · ${status} `, inner, "");
  const top = `${theme.fg("borderAccent", "╭")}${title}${theme.fg(
    "borderAccent",
    `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`,
  )}`;
  if (height === 1) return [truncateToWidth(top, width, "")];
  const savedEntry = state.entries.find((entry) => entry.current);
  const activeSelectionLabel = state.activeSelectionLabel ?? savedEntry?.label ?? "Built-in routes";
  const savedSelectionLabel = state.savedSelectionLabel ?? savedEntry?.label ?? "Built-in routes";
  const selectionPending = state.reloadRequired || activeSelectionLabel !== savedSelectionLabel;
  const confirmation = state.pendingConfirmation;
  const confirmationRows =
    confirmation?.kind === "use"
      ? [
          theme.fg("warning", theme.bold(`Confirm · Use ${confirmation.label}?`)),
          theme.fg("toolOutput", `  Set     ${confirmation.label}`),
          theme.fg(
            "toolOutput",
            `  Reload  ${confirmation.reloadRequired ? "Required after activation" : "Not required; this default is already active"}`,
          ),
        ]
      : confirmation?.kind === "delete"
        ? [
            theme.fg("warning", theme.bold(`Confirm · Delete ${confirmation.label}?`)),
            theme.fg("toolOutput", `  Set     ${confirmation.label}`),
            theme.fg("toolOutput", "  Change  Remove this set from saved profile settings"),
          ]
        : [];
  const header = [
    theme.fg("accent", theme.bold("Profile sets")),
    `Active now       ${activeSelectionLabel}`,
    ...(selectionPending ? [`Saved selection  ${savedSelectionLabel} · reload required`] : []),
    ...(state.sessionOverrideCount > 0
      ? [
          `Session  ${state.sessionOverrideCount} temporary profile override${state.sessionOverrideCount === 1 ? "" : "s"}`,
        ]
      : []),
    ...(state.searching ? [`Search   /${state.query}`] : []),
    ...(confirmationRows.length > 0
      ? confirmationRows
      : state.message
        ? [
            theme.fg(
              state.message.kind === "error"
                ? "error"
                : state.message.kind === "warning"
                  ? "warning"
                  : "muted",
              state.message.text,
            ),
          ]
        : []),
    "",
  ];
  const selected = state.entries[state.selectedIndex];
  const contextualActions =
    selected?.kind === "set"
      ? "e Edit · n New · c Copy · R Rename · x Delete · / Search"
      : "n New · / Search";
  const compactContextualActions = selected?.kind === "set" ? "e · n · c · R · x · /" : "n · /";
  const footer = confirmation
    ? renderResponsiveManagerFooter(inner, [["Enter Confirm · Esc Cancel"]])
    : renderResponsiveManagerFooter(inner, [
        [
          "↑/↓ Select · Enter Edit · u Use",
          contextualActions,
          state.reloadRequired ? "r Reload · Esc Close" : "Esc Close",
        ],
        [
          "↑/↓ · Enter Edit · u Use",
          compactContextualActions,
          state.reloadRequired ? "r · Esc" : "Esc",
        ],
      ]);
  const bodyHeight = Math.max(0, height - 2);
  const listHeight = Math.max(1, bodyHeight - header.length - 1);
  const logicalRows: ReadonlyArray<{ readonly text: string; readonly entryIndex?: number }> =
    (() => {
      const rows: Array<{ readonly text: string; readonly entryIndex?: number }> = [];
      let priorScope: "global" | "project" | undefined;
      for (let index = 0; index < state.entries.length; index += 1) {
        const entry = state.entries[index];
        if (!entry) continue;
        if (entry.scope !== priorScope) {
          rows.push({
            text: theme.fg("muted", entry.scope === "project" ? "Project" : "Global"),
          });
          priorScope = entry.scope;
        }
        const marker = index === state.selectedIndex ? ">" : " ";
        const savedMarker = entry.current ? " saved" : "";
        rows.push({
          entryIndex: index,
          text: truncateToWidth(
            `${marker} ${entry.label}${savedMarker.padEnd(10)} · ${entry.description}`,
            inner,
          ),
        });
      }
      return rows;
    })();
  const selectedRow = Math.max(
    0,
    logicalRows.findIndex((row) => row.entryIndex === state.selectedIndex),
  );
  const start = windowStart(logicalRows.length, selectedRow, listHeight);
  const rows = logicalRows.slice(start, start + listHeight).map((row) => row.text);
  if (state.entries.length === 0)
    rows.push("No profile sets are available. Press n to create one.");
  const bodyRows = [...header, ...rows];
  const body = bodyRows
    .slice(0, bodyHeight)
    .map(
      (line) =>
        `${theme.fg("borderAccent", "│")}${pad(line, inner)}${theme.fg("borderAccent", "│")}`,
    );
  while (body.length < bodyHeight)
    body.push(
      `${theme.fg("borderAccent", "│")}${" ".repeat(inner)}${theme.fg("borderAccent", "│")}`,
    );
  const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
    "borderAccent",
    "─".repeat(Math.max(0, inner - visibleWidth(footer))),
  )}${truncateToWidth(footer, inner, "")}${theme.fg("borderAccent", "╯")}`;
  return [truncateToWidth(top, width, ""), ...body, truncateToWidth(bottom, width, "")];
};
