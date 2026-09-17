import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import { padListDetailRow, wideListDetailGeometry } from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import {
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
} from "./profile-set-picker-model.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

export interface ProfileSetPickerRenderState {
  readonly entries: ReadonlyArray<ProfileSetPickerEntry>;
  readonly selectedIndex: number;
  readonly query: string;
  readonly searching: boolean;
  readonly projectTrusted?: boolean | undefined;
  readonly message?: { readonly kind: "info" | "warning" | "error"; readonly text: string };
  readonly actionMenu?:
    | {
        readonly label: string;
        readonly choices: ReadonlyArray<{
          readonly label: string;
          readonly description: string;
          readonly enabled: boolean;
        }>;
        readonly selectedIndex: number;
      }
    | undefined;
  readonly pendingDeleteLabel?: string | undefined;
}

const windowStart = (length: number, selected: number, visible: number): number =>
  Math.max(0, Math.min(Math.max(0, length - visible), selected - Math.floor(visible / 2)));

const footer = (
  state: ProfileSetPickerRenderState,
  width: number,
  keybindingLabel: SearchableSelectHostOptions["keybindingLabel"],
): string => {
  const label = keybindingLabel ?? ((_id, fallback) => fallback);
  const reserved = new Set(state.actionMenu || state.pendingDeleteLabel ? [] : ["/", "a", "u"]);
  const confirm = filterReservedKeyLabel(label("tui.select.confirm", "Enter"), reserved, "Enter");
  const cancel = filterReservedKeyLabel(label("tui.select.cancel", "Esc"), reserved, "Esc");
  if (state.pendingDeleteLabel)
    return renderResponsiveManagerFooter(width, [[`${confirm} Confirm · ${cancel} Cancel`]]);
  if (state.actionMenu)
    return renderResponsiveManagerFooter(width, [[`${confirm} Choose · ${cancel} Back`]]);
  if (state.searching)
    return renderResponsiveManagerFooter(width, [
      [`Type to filter · ${confirm} Edit · ${cancel} Clear`],
    ]);
  return renderResponsiveManagerFooter(width, [
    [`${confirm} Edit`, "u Use", "a More", "Tab Current Session", `${cancel} Close`],
    ["Tab Current Session", "a More", `${cancel} Close`],
  ]);
};

const menuRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const menu = state.actionMenu;
  if (!menu) return [];
  const limit = Math.max(1, height - 5);
  const start = windowStart(menu.choices.length, menu.selectedIndex, limit);
  const selected = menu.choices[menu.selectedIndex];
  return [
    theme.fg("accent", theme.bold(menu.label)),
    theme.fg("muted", "Choose an action"),
    "",
    ...menu.choices.slice(start, start + limit).map((choice, offset) => {
      const index = start + offset;
      return `${index === menu.selectedIndex ? ">" : " "} ${choice.label}${choice.enabled ? "" : " · unavailable"}`;
    }),
    ...(selected && height >= 6 ? ["", theme.fg("muted", selected.description)] : []),
  ];
};

const libraryRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const header = [
    theme.fg("accent", theme.bold("Saved profile sets")),
    ...(state.searching ? [theme.fg("muted", `Search /${state.query}`)] : []),
    ...(state.message
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
    theme.fg("muted", 'Saved sets stay separate until you choose "Use in Current Session".'),
    "",
  ].slice(0, Math.max(0, height - 1));
  const logical: Array<{ readonly text: string; readonly entryIndex?: number }> = [];
  let scope: "project" | "global" | undefined;
  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];
    if (!entry) continue;
    if (entry.scope !== scope) {
      scope = entry.scope;
      logical.push({ text: theme.fg("accent", entry.scope === "project" ? "Project" : "Global") });
    }
    const selected = index === state.selectedIndex;
    const invalid =
      entry.kind === "set" && entry.invalid
        ? " · ! fix profiles"
        : entry.kind === "invalid-default"
          ? " · ! clear"
          : "";
    const defaultLabel =
      (entry.kind === "set" || entry.kind === "invalid-default") && entry.scopeDefault
        ? " · default"
        : "";
    logical.push({
      entryIndex: index,
      text: `${selected ? ">" : " "} ${entry.label}${defaultLabel}${invalid}${selected ? ` · ${entry.description}` : ""}`,
    });
  }
  const listHeight = Math.max(1, height - header.length);
  const selectedRow = Math.max(
    0,
    logical.findIndex((row) => row.entryIndex === state.selectedIndex),
  );
  const start = windowStart(logical.length, selectedRow, listHeight);
  return [...header, ...logical.slice(start, start + listHeight).map((row) => row.text)];
};

const previewRows = (
  state: ProfileSetPickerRenderState,
  theme: Theme,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const entry = state.entries[state.selectedIndex];
  if (!entry) return [theme.fg("muted", "No saved sets match this search.")];
  if (entry.kind !== "set") return wrapTextWithAnsi(entry.description, width);
  const rows = [theme.fg("accent", theme.bold(qualifiedProfileSetLabel(entry.ref)))];
  const budget = Math.max(1, Math.floor((height - 1) / entry.preview.length));
  const profiles = entry.preview.map((profile) => ({
    ...profile,
    label: `${profile.id}${profile.inherited ? ` · inherited ${profile.source.replace("-invalid", "")}` : ""}`,
    cells:
      profile.status === "configured"
        ? profile.candidates.map((candidate, index) => [
            index === 0 ? "Primary" : `Fallback ${index}`,
            `${candidate.model}${candidate.openaiFastMode ? " ⚡" : ""}`,
            candidate.effort === "default" ? "profile default" : candidate.effort,
            `${candidate.host}/${candidate.runtime}`,
          ])
        : [[profile.status, "", "", ""]],
  }));
  // Measure the whole preview so candidate and profile changes do not shift later columns.
  const profileWidth = Math.max(0, ...profiles.map((profile) => visibleWidth(profile.label)));
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(
      0,
      ...profiles.flatMap((profile) =>
        profile.cells.map((cells) => visibleWidth(cells[column] ?? "")),
      ),
    ),
  );
  const modelWidth = Math.min(
    widths[1] ?? 0,
    width - profileWidth - (widths[0] ?? 0) - (widths[2] ?? 0) - (widths[3] ?? 0) - 8,
  );
  const aligned = modelWidth >= Math.min(16, widths[1] ?? 0);
  widths[1] = Math.max(0, modelWidth);
  for (const profile of profiles) {
    const lines = profile.cells.flatMap((cells, index) => {
      const label = index === 0 ? profile.label : "";
      if (!aligned) {
        const detail = cells.filter(Boolean).join(" · ");
        return wrapTextWithAnsi(`${label ? `${label}: ` : "  "}${detail}`, width);
      }
      return [
        [
          padListDetailRow(label, profileWidth),
          ...cells.map((cell, column) =>
            padListDetailRow(truncateToWidth(cell, widths[column] ?? 0), widths[column] ?? 0),
          ),
        ].join("  "),
      ];
    });
    const visible = lines.slice(0, budget);
    if (lines.length > budget) {
      visible[budget - 1] =
        truncateToWidth(visible[budget - 1] ?? "", Math.max(0, width - 1), "") + "…";
    }
    rows.push(
      ...visible.map((line) => theme.fg(profile.status === "invalid" ? "warning" : "text", line)),
    );
  }
  if (rows.length < height)
    rows.push(theme.fg("dim", "Enter edits the full routes. Current Session is unchanged."));
  return rows;
};

export const renderProfileSetPicker = (
  state: ProfileSetPickerRenderState,
  options: Pick<SearchableSelectHostOptions, "keybindingLabel"> & {
    readonly theme: Theme;
    readonly width: number;
    readonly height: number;
  },
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const theme = options.theme;
  const frame = listDetailFrame(theme);
  const inner = width - 2;
  const title = truncateToWidth(" /subagents profiles › Profile sets ", inner, "");
  const bottom = truncateToWidth(footer(state, inner, options.keybindingLabel), inner, "");
  return framedScreen(frame, {
    width,
    height,
    top: title,
    bottom,
    body: (bodyHeight) => {
      const rows = state.pendingDeleteLabel
        ? [
            theme.fg("warning", theme.bold(`Delete ${state.pendingDeleteLabel}?`)),
            theme.fg("warning", "This deletes the saved set. Current Session will not change."),
            theme.fg("warning", footer(state, inner, options.keybindingLabel)),
          ]
        : state.actionMenu
          ? menuRows(state, theme, bodyHeight)
          : libraryRows(state, theme, bodyHeight);
      if (bodyHeight <= 4) {
        const selectedAction = state.actionMenu?.choices[state.actionMenu.selectedIndex];
        const compactMenu =
          state.actionMenu && selectedAction
            ? bodyHeight === 1
              ? [`> ${selectedAction.label}${selectedAction.enabled ? "" : " · unavailable"}`]
              : [
                  theme.fg("accent", theme.bold(state.actionMenu.label)),
                  `> ${selectedAction.label}${selectedAction.enabled ? "" : " · unavailable"}`,
                  theme.fg("muted", selectedAction.description),
                ]
            : rows;
        const safety = state.pendingDeleteLabel
          ? rows
          : state.actionMenu
            ? compactMenu
            : [
                (() => {
                  const entry = state.entries[state.selectedIndex];
                  return entry
                    ? `> ${entry.kind === "set" ? qualifiedProfileSetLabel(entry.ref) : entry.label}`
                    : "No saved sets";
                })(),
                ...(state.message ? [state.message.text] : []),
                theme.fg("dim", footer(state, inner, options.keybindingLabel)),
              ];
        return framedFill(frame, safety.slice(0, bodyHeight), bodyHeight, inner);
      }
      if (!state.actionMenu && !state.pendingDeleteLabel) {
        if (width >= 100) {
          const { listWidth, detailWidth } = wideListDetailGeometry(width, 30, 0.35);
          return framedWideRows(frame, {
            left: rows,
            right: previewRows(state, theme, detailWidth, bodyHeight),
            height: bodyHeight,
            listWidth,
            detailWidth,
          });
        }
        if (bodyHeight >= 14) {
          const listHeight = Math.max(4, Math.min(8, Math.floor(bodyHeight / 3)));
          return framedStackedRows(frame, {
            list: libraryRows(state, theme, listHeight),
            detail: previewRows(state, theme, inner, bodyHeight - listHeight - 1),
            height: bodyHeight,
            inner,
          });
        }
      }
      return framedFill(frame, rows.slice(0, bodyHeight), bodyHeight, inner);
    },
  });
};
