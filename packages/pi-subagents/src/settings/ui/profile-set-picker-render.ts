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
  readonly projectTrusted?: boolean | undefined;
  readonly alternateHelp?: boolean | undefined;
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
  const statusParts = [
    state.reloadRequired ? "reload pending · r Reload" : undefined,
    state.sessionOverrideCount > 0
      ? `${state.sessionOverrideCount} session override${state.sessionOverrideCount === 1 ? "" : "s"}`
      : undefined,
    state.projectTrusted === false ? "Project locked" : undefined,
  ].filter((part): part is string => part !== undefined);
  const status =
    statusParts.length > 0
      ? theme.fg(
          state.reloadRequired || state.projectTrusted === false ? "warning" : "accent",
          statusParts.join(" · "),
        )
      : undefined;
  const title = truncateToWidth(
    status ? ` /subagents profiles › Sets · ${status} ` : " /subagents profiles › Sets ",
    inner,
    "",
  );
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
          theme.fg(
            "toolOutput",
            confirmation.reloadRequired ? "Reload required after activation" : "Already active",
          ),
        ]
      : confirmation?.kind === "delete"
        ? [
            theme.fg("warning", theme.bold(`Confirm · Delete ${confirmation.label}?`)),
            theme.fg("toolOutput", "Removes this saved set"),
          ]
        : [];
  const pendingSelectionRows = selectionPending
    ? height <= 5
      ? [theme.fg("warning", `${activeSelectionLabel} → ${savedSelectionLabel} · reload required`)]
      : [
          `Active  ${activeSelectionLabel}`,
          theme.fg("warning", `Saved   ${savedSelectionLabel} · reload required`),
        ]
    : [];
  const header = [
    ...(state.searching ? [`Search  /${state.query}`] : []),
    ...pendingSelectionRows,
    ...(state.projectTrusted === false
      ? [theme.fg("warning", "Project sets unavailable until the project is trusted")]
      : []),
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
  ];
  const selected = state.entries[state.selectedIndex];
  const extendedActions =
    selected?.kind === "set"
      ? "e Edit · n New · c Copy · R Rename · x Delete · / Search"
      : "n New · / Search";
  const compactExtendedActions = selected?.kind === "set" ? "e · n · c · R · x · /" : "n · /";
  const footer = confirmation
    ? renderResponsiveManagerFooter(inner, [["Enter Confirm · Esc Cancel"]])
    : state.searching
      ? renderResponsiveManagerFooter(inner, [
          ["Type to filter · ↑/↓ Select", "Enter Edit · Esc Clear"],
          ["↑/↓ Select", "Enter · Esc"],
        ])
      : state.alternateHelp
        ? renderResponsiveManagerFooter(inner, [
            [
              "↑/↓ Select · Enter Edit · u Use",
              extendedActions,
              `${state.reloadRequired ? "r Reload · " : ""}? Less · Esc Close`,
            ],
            [
              "↑/↓ · Enter · u",
              compactExtendedActions,
              `${state.reloadRequired ? "r · " : ""}? · Esc`,
            ],
          ])
        : renderResponsiveManagerFooter(inner, [
            ["↑/↓ Select · Enter Edit · u Use", "? More · Esc Close"],
            ["↑/↓ · Enter · u", "? · Esc"],
          ]);
  const bodyHeight = Math.max(0, height - 2);
  const normalHeaderBudget = state.searching && bodyHeight === 1 ? 1 : Math.max(0, bodyHeight - 1);
  const visibleHeader = confirmation
    ? header.slice(0, bodyHeight)
    : header.slice(0, normalHeaderBudget);
  const separateHeader = visibleHeader.length > 0 && bodyHeight - visibleHeader.length >= 2;
  const listHeight = Math.max(1, bodyHeight - visibleHeader.length - (separateHeader ? 1 : 0));
  const logicalRows: ReadonlyArray<{ readonly text: string; readonly entryIndex?: number }> =
    (() => {
      const rows: Array<{ readonly text: string; readonly entryIndex?: number }> = [];
      for (let index = 0; index < state.entries.length; index += 1) {
        const entry = state.entries[index];
        if (!entry) continue;
        const selectedEntry = index === state.selectedIndex;
        const marker = selectedEntry ? ">" : " ";
        const savedMarker = entry.current ? " · saved" : "";
        const invalid = entry.kind === "invalid-default" || (entry.kind === "set" && entry.invalid);
        const invalidBadge = invalid ? " · ! invalid" : "";
        const detail = selectedEntry ? ` · ${entry.description}` : "";
        rows.push({
          entryIndex: index,
          text: truncateToWidth(
            `${marker} ${entry.label}${savedMarker}${invalidBadge}${detail}`,
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
  const bodyRows = [...visibleHeader, ...(separateHeader ? [""] : []), ...rows];
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
