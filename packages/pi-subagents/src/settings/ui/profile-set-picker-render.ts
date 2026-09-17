import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { managerLayoutTier, renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { managerTable } from "pi-cosmic-ui/manager/table";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import { wideListDetailGeometry } from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedStackedRows,
  listDetailHeading,
} from "pi-cosmic-ui/manager/list-detail-shell";
import {
  qualifiedProfileSetLabel,
  type ProfileSetPickerEntry,
} from "./profile-set-picker-model.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import {
  focusedProfileField,
  profileFrame,
  profilePaneRows,
  profileTone,
} from "./profile-style.ts";

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
    theme.fg(profileTone.saved, theme.bold(menu.label)),
    theme.fg("muted", "Choose an action"),
    "",
    ...menu.choices.slice(start, start + limit).map((choice, offset) => {
      const index = start + offset;
      const text = `${index === menu.selectedIndex ? ">" : " "} ${choice.label}${choice.enabled ? "" : " · unavailable"}`;
      return !choice.enabled
        ? theme.fg("muted", text)
        : index === menu.selectedIndex
          ? focusedProfileField(theme, text)
          : text;
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
    listDetailHeading(theme, "Saved profile sets", true, profileTone.saved),
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
      logical.push({ text: theme.fg("muted", entry.scope === "project" ? "Project" : "Global") });
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
      text: `${selected ? ">" : " "} ${selected && !state.searching ? focusedProfileField(theme, entry.label) : theme.fg(profileTone.saved, entry.label)}${theme.fg("muted", defaultLabel)}${theme.fg("error", invalid)}${selected ? theme.fg("muted", ` · ${entry.description}`) : ""}`,
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
  if (entry.kind !== "set")
    return wrapTextWithAnsi(
      theme.fg(entry.kind === "invalid-default" ? "error" : "muted", entry.description),
      width,
    );
  const rows = [
    listDetailHeading(theme, qualifiedProfileSetLabel(entry.ref), false, profileTone.saved),
  ];
  const budget = Math.max(1, Math.floor((height - 1) / entry.preview.length));
  const profiles = entry.preview.map((profile) => ({
    ...profile,
    label: `${theme.fg(profileTone.profile, profile.id)}${profile.inherited ? theme.fg("muted", ` · inherited ${profile.source.replace("-invalid", "")}`) : ""}`,
    cells:
      profile.status === "configured"
        ? profile.candidates.map((candidate, index) => [
            theme.fg("muted", index === 0 ? "Primary" : `Fallback ${index}`),
            `${theme.fg(profileTone.model, candidate.model)}${candidate.openaiFastMode ? theme.fg("warning", " ⚡") : ""}`,
            theme.fg(
              "muted",
              candidate.effort === "default" ? "profile default" : candidate.effort,
            ),
            theme.fg("muted", `${candidate.host}/${candidate.runtime}`),
          ])
        : [
            [
              theme.fg(profile.status === "invalid" ? "error" : "muted", profile.status),
              "",
              "",
              "",
            ],
          ],
  }));
  const table = managerTable(
    profiles.flatMap((profile) => profile.cells.map((cells) => [profile.label, ...cells])),
    [
      { minWidth: 10, priority: 5 },
      { minWidth: 7, priority: 2 },
      { minWidth: 16, priority: 4 },
      { minWidth: 7, priority: 3 },
      { minWidth: 8, priority: 1 },
    ],
    width,
  );
  const aligned =
    table.widths.every((size) => size > 0) &&
    profiles.every((profile) =>
      profile.cells.every((cells) => visibleWidth(cells[1] ?? "") <= (table.widths[2] ?? 0)),
    );
  for (const profile of profiles) {
    const lines = profile.cells.flatMap((cells, index) => {
      const label = index === 0 ? profile.label : "";
      if (!aligned) {
        const detail = cells.filter(Boolean).join(" · ");
        return wrapTextWithAnsi(`${label ? `${label}: ` : "  "}${detail}`, width);
      }
      return [table.row([label, ...cells])];
    });
    const visible = lines.slice(0, budget);
    if (lines.length > budget) {
      visible[budget - 1] =
        truncateToWidth(visible[budget - 1] ?? "", Math.max(0, width - 1), "") + "…";
    }
    rows.push(...visible);
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
  const frame = profileFrame(theme, true);
  const inner = width - 2;
  const title = truncateToWidth(" /subagents profiles › Profile sets ", inner, "");
  const bottom = truncateToWidth(footer(state, inner, options.keybindingLabel), inner, "");
  return framedScreen(frame, {
    width,
    height,
    top: theme.fg(profileTone.saved, title),
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
                  theme.fg(profileTone.saved, theme.bold(state.actionMenu.label)),
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
                    ? theme.fg(
                        entry.kind === "invalid-default" || (entry.kind === "set" && entry.invalid)
                          ? "error"
                          : profileTone.saved,
                        theme.bold(
                          `> ${entry.kind === "set" ? qualifiedProfileSetLabel(entry.ref) : entry.label}`,
                        ),
                      )
                    : "No saved sets";
                })(),
                ...(state.message
                  ? [
                      theme.fg(
                        state.message.kind === "info" ? "muted" : state.message.kind,
                        state.message.text,
                      ),
                    ]
                  : []),
                theme.fg("dim", footer(state, inner, options.keybindingLabel)),
              ];
        return framedFill(frame, safety.slice(0, bodyHeight), bodyHeight, inner, "list");
      }
      if (!state.actionMenu && !state.pendingDeleteLabel) {
        if (managerLayoutTier(width) === "wide") {
          const { listWidth, detailWidth } = wideListDetailGeometry(width, 30, 0.35);
          return profilePaneRows(theme, {
            focused: "list",
            left: rows,
            right: previewRows(state, theme, detailWidth, bodyHeight),
            height: bodyHeight,
            listWidth,
            detailWidth,
          });
        }
        if (managerLayoutTier(width) === "stacked" && bodyHeight >= 6) {
          const listHeight = Math.max(4, Math.min(8, Math.floor(bodyHeight / 3)));
          const list = libraryRows(state, theme, listHeight);
          return framedStackedRows(profileFrame(theme, true), {
            list,
            detail: previewRows(state, theme, inner, bodyHeight - listHeight - 1),
            height: bodyHeight,
            inner,
          });
        }
      }
      return framedFill(frame, rows.slice(0, bodyHeight), bodyHeight, inner, "list");
    },
  });
};
