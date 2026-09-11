import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  managerLayoutTier,
  managerNoticeGlyph,
  renderResponsiveManagerFooter,
} from "pi-cosmic-ui/manager";
import {
  listWindowStart,
  stackedListHeight,
  wideListDetailGeometry,
} from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  detailFieldRows,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { PROFILE_IDS, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type {
  ProfileRouteDraft,
  ProfileSettingsInspection,
  ProfileSettingsScope,
  ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateFieldRows,
  candidateFastModeApplied,
  candidateEffortLabel,
  draftKindLabel,
  profileDescription,
  profileRouteDraftSummary,
  profileRouteOptionLabel,
  runWithLabel,
  targetProfilePrimarySummary,
  type ProfileWorkspaceField,
  type ProfileWorkspacePane,
} from "./profile-workspace-model.ts";
import type { SettingsSelectKeybindingId } from "pi-cosmic-ui/manager/searchable-select";
import { profileWorkspaceKeys, type ProfileWorkspaceKeys } from "./profile-workspace-keys.ts";

export interface ProfileWorkspaceConfirmation {
  readonly title: string;
  readonly detail: string;
  readonly preview?: ReadonlyArray<string> | undefined;
}

export interface ProfileWorkspaceRenderState {
  readonly inspection: ProfileSettingsInspection;
  readonly target: ProfileWorkspaceTarget;
  readonly scope: ProfileSettingsScope;
  readonly projectTrusted: boolean;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  readonly pane: ProfileWorkspacePane;
  readonly profileIndex: number;
  readonly candidateIndex: number;
  readonly fieldIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly advancedExpanded?: boolean | undefined;
  readonly busy: boolean;
  readonly cancellableBusy: boolean;
  readonly message?:
    | { readonly kind: "info" | "success" | "warning" | "error"; readonly text: string }
    | undefined;
  readonly pendingConfirmation?: ProfileWorkspaceConfirmation | undefined;
}

export interface ProfileWorkspaceRenderOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
}

const selectedProfile = (state: ProfileWorkspaceRenderState): ProfileId =>
  PROFILE_IDS[state.profileIndex] ?? PROFILE_IDS[0];

const wrapped = (text: string, width: number): ReadonlyArray<string> =>
  wrapTextWithAnsi(text, Math.max(1, width));

const sessionOrigin = (inspection: ProfileSettingsInspection): string => {
  const origin = inspection.session.baseline.origin;
  if (origin.scope === "builtin") return "built-in defaults";
  if (origin.invalid || !origin.name)
    return `${origin.scope === "project" ? "Project" : "Global"} default with an error`;
  return `${origin.scope === "project" ? "Project" : "Global"}/${origin.name}`;
};

const workspaceHeading = (state: ProfileWorkspaceRenderState): string => {
  if (state.target.kind === "profile-set")
    return `Saved set · ${state.target.set.scope === "project" ? "Project" : "Global"}/${state.target.set.name} · Current Session unchanged`;
  const dirty = Object.keys(state.inspection.session.overrides).length;
  return dirty === 0
    ? `Current Session · based on ${sessionOrigin(state.inspection)} · no changes`
    : `Current Session · based on ${sessionOrigin(state.inspection)} · ${dirty} profile${dirty === 1 ? "" : "s"} changed`;
};

const confirmationNotices = (
  confirmation: ProfileWorkspaceConfirmation,
  theme: Theme,
  width: number,
  height: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  const title = wrapped(theme.fg("warning", theme.bold(`Confirm · ${confirmation.title}`)), width);
  const detail = wrapped(theme.fg("warning", confirmation.detail), width);
  const preview = (confirmation.preview ?? []).flatMap((line) =>
    wrapped(theme.fg("toolOutput", line), width),
  );
  const hint = theme.fg("warning", `${keys.confirm} confirms · ${keys.cancel} cancels`);
  const all = [...title, ...detail, ...preview, hint];
  const limit = Math.max(0, height);
  if (all.length <= limit) return all;
  if (limit === 0) return [];
  if (limit === 1) return title.slice(0, 1);
  if (limit === 2) return [...title.slice(0, 1), ...detail.slice(0, 1)];

  let titleCount = Math.min(1, title.length);
  let detailCount = Math.min(1, detail.length);
  let remaining = limit - titleCount - detailCount - 1;
  const takeMore = (current: number, total: number): number => {
    const added = Math.min(remaining, Math.max(0, total - current));
    remaining -= added;
    return current + added;
  };
  detailCount = takeMore(detailCount, detail.length);
  titleCount = takeMore(titleCount, title.length);
  const previewCount = Math.min(remaining, preview.length);
  return [
    ...title.slice(0, titleCount),
    ...detail.slice(0, detailCount),
    ...preview.slice(0, previewCount),
    hint,
  ];
};

const notices = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  height: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  if (state.pendingConfirmation)
    return confirmationNotices(state.pendingConfirmation, theme, width, height, keys);
  if (state.message?.kind === "success") return [];
  if (state.message) {
    const color =
      state.message.kind === "error"
        ? "error"
        : state.message.kind === "warning"
          ? "warning"
          : "muted";
    return wrapped(
      theme.fg(color, `${managerNoticeGlyph(state.message.kind)} ${state.message.text}`),
      width,
    ).slice(0, Math.max(0, height));
  }
  if (!state.projectTrusted && state.target.kind === "session")
    return [theme.fg("warning", "Trust this project to edit Project sets")].slice(
      0,
      Math.max(0, height),
    );
  return [];
};

const candidateRow = (
  state: ProfileWorkspaceRenderState,
  profile: ProfileId,
  index: number,
  selected: boolean,
): string => {
  const candidate = state.draft.candidates[index];
  if (!candidate) return "";
  const fast = candidateFastModeApplied(candidate, state.parentModel) ? " ⚡" : "";
  return `${selected ? ">" : " "} ${profileRouteOptionLabel(index).padEnd(10)} ${candidate.model} · ${candidateEffortLabel(profile, candidate, state.parentEffort)}${fast}`;
};

const profileList = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const limit = Math.max(1, height - 1);
  const start = listWindowStart(PROFILE_IDS.length, state.profileIndex, limit);
  const selected = selectedProfile(state);
  return [
    theme.fg("accent", theme.bold("Profiles")),
    ...PROFILE_IDS.slice(start, start + limit).map((profile, offset) => {
      const index = start + offset;
      const summary = targetProfilePrimarySummary(
        state.inspection,
        state.target,
        profile,
        profile === selected ? state.draft : undefined,
      );
      return `${index === state.profileIndex ? ">" : " "} ${profile.padEnd(13)} ${summary}`;
    }),
  ];
};

const profileDetail = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  return [
    theme.fg("accent", theme.bold(profile)),
    ...wrapped(theme.fg("muted", profileDescription(profile)), width),
    "",
    `${draftKindLabel(state.draft, state.scope)} · ${profileRouteDraftSummary(profile, state.draft, state.parentEffort, state.parentModel)}`,
    "",
    ...(state.draft.candidates.length > 0
      ? state.draft.candidates.map((_candidate, index) =>
          candidateRow(state, profile, index, false),
        )
      : [
          state.draft.kind === "invalid"
            ? `${managerNoticeGlyph("error")} Invalid profile, won't run until fixed`
            : "Profile disabled",
        ]),
    "",
    theme.fg(
      "dim",
      `${keys.up}/${keys.down} selects profiles · ${keys.confirm} edits Primary and fallbacks`,
    ),
  ];
};

const candidateList = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const count = state.draft.candidates.length;
  const limit = Math.max(1, height - 1);
  const start = listWindowStart(count, state.candidateIndex, limit);
  return [
    theme.fg("accent", theme.bold(`${profile} · choice order`)),
    ...(count > 0
      ? state.draft.candidates
          .slice(start, start + limit)
          .map((_candidate, offset) =>
            candidateRow(state, profile, start + offset, start + offset === state.candidateIndex),
          )
      : [state.draft.kind === "invalid" ? "> Invalid profile" : "> Profile disabled"]),
  ];
};

const candidateDetail = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  if (!candidate)
    return [
      theme.fg("accent", theme.bold(profile)),
      ...wrapped(theme.fg("muted", profileDescription(profile)), width),
      "",
      state.draft.kind === "invalid"
        ? "This profile won't run until fixed."
        : "This profile is disabled and won't run.",
      "",
      theme.fg("dim", `${keys.confirm} opens Actions so you can add or fix the profile`),
    ];
  return [
    theme.fg("accent", theme.bold(`${profile} · ${profileRouteOptionLabel(state.candidateIndex)}`)),
    ...wrapped(theme.fg("muted", profileDescription(profile)), width),
    "",
    ...detailFieldRows(theme, [
      { label: "Model", value: candidate.model },
      { label: "Reasoning", value: candidateEffortLabel(profile, candidate, state.parentEffort) },
      { label: "File access", value: candidate.writeIntent },
      { label: "Run with", value: runWithLabel(candidate) },
    ]),
    "",
    theme.fg(
      "dim",
      `${keys.up}/${keys.down} selects Primary and fallbacks · ${keys.confirm} edits these settings`,
    ),
  ];
};

const fieldRows = (state: ProfileWorkspaceRenderState) => {
  const profile = selectedProfile(state);
  const candidate = state.draft.candidates[state.candidateIndex];
  if (!candidate)
    return [
      { field: "actions" as const, label: "Actions", value: "add or fix profile", fixed: false },
    ];
  return candidateFieldRows(
    candidate,
    profile,
    state.parentEffort,
    state.parentModel,
    state.advancedExpanded,
    { index: state.candidateIndex, count: state.draft.candidates.length },
  );
};

const fieldsList = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  height: number,
): ReadonlyArray<string> => {
  const rows = fieldRows(state);
  const limit = Math.max(1, height - 1);
  const start = listWindowStart(rows.length, state.fieldIndex, limit);
  const labelWidth = rows.reduce((maximum, row) => Math.max(maximum, visibleWidth(row.label)), 0);
  return [
    theme.fg(
      "accent",
      theme.bold(`${selectedProfile(state)} · ${profileRouteOptionLabel(state.candidateIndex)}`),
    ),
    ...rows.slice(start, start + limit).map((row, offset) => {
      const marker = start + offset === state.fieldIndex ? ">" : " ";
      return `${marker} ${row.label.padEnd(labelWidth)}  ${row.value}${row.fixed ? " · can't change" : ""}`;
    }),
  ];
};

const fieldHelp = {
  model: "Choose the model for this Primary or Fallback.",
  effort: "Choose a reasoning level. Profile default uses this profile's usual setting.",
  writeIntent: "Choose read-only or writer access. Safety restrictions still apply.",
  runWith: "Choose a Local or Herdr run with Pi, Claude, or Codex.",
  advanced: "Choose context, OpenAI fast mode, and whether the run stays open after reporting.",
  context: "Fresh starts without earlier context. Fork is available only with Local Pi.",
  openaiFastMode: "Fast mode requests OpenAI priority service when the model supports it.",
  closeOnReport: "Only Herdr read-only runs can stay open after reporting.",
  "move-up": "Move this model earlier in the fallback order. The first model becomes Primary.",
  "move-down": "Move this model later in the fallback order. The first model becomes Primary.",
  remove:
    "Delete this model from the profile after confirmation. Deleting the last model disables the profile.",
  actions:
    "Add, copy, reorder, or remove Primary/Fallback choices. You can also disable or restore the profile.",
} satisfies Readonly<Record<ProfileWorkspaceField, string>>;

const fieldDetail = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  width: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const row = fieldRows(state)[state.fieldIndex] ?? fieldRows(state)[0];
  if (!row) return [];
  return [
    theme.fg("accent", theme.bold(row.label.trim())),
    ...wrapped(theme.fg("muted", profileDescription(profile)), width),
    "",
    ...wrapped(fieldHelp[row.field], width),
    "",
    ...detailFieldRows(theme, [{ label: "Current", value: row.value }]),
    "",
    theme.fg(
      "dim",
      `${keys.up}/${keys.down} selects settings · ${keys.confirm} changes the selected row`,
    ),
    ...(row.fixedReason ? ["", ...wrapped(theme.fg("warning", row.fixedReason), width)] : []),
  ];
};

const pageRows = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  listHeight: number,
  detailWidth: number,
  keys: ProfileWorkspaceKeys,
) => {
  if (state.pane === "profiles")
    return {
      list: profileList(state, theme, listHeight),
      detail: profileDetail(state, theme, detailWidth, keys),
    };
  if (state.pane === "candidates")
    return {
      list: candidateList(state, theme, listHeight),
      detail: candidateDetail(state, theme, detailWidth, keys),
    };
  return {
    list: fieldsList(state, theme, listHeight),
    detail: fieldDetail(state, theme, detailWidth, keys),
  };
};

const footer = (
  state: ProfileWorkspaceRenderState,
  width: number,
  labels: ProfileWorkspaceRenderOptions["keybindingLabel"],
): string => {
  const { confirm: enter, cancel: escape } = profileWorkspaceKeys(
    labels,
    Boolean(state.pendingConfirmation) || state.busy,
  );
  if (state.pendingConfirmation)
    return renderResponsiveManagerFooter(width, [
      [`${enter} Confirm`, `${escape} Cancel`],
      [enter, escape],
    ]);
  if (state.busy)
    return renderResponsiveManagerFooter(width, [
      [state.cancellableBusy ? `Loading models · ${escape} Cancel` : "Saving · please wait"],
    ]);
  const row = fieldRows(state)[state.fieldIndex];
  const edit =
    state.pane !== "fields"
      ? "Edit"
      : row?.field === "actions"
        ? "Actions"
        : row?.field === "advanced"
          ? "Show or hide"
          : "Change";
  const back =
    state.pane === "profiles"
      ? "Close"
      : state.pane === "fields" && state.draft.candidates.length > 1
        ? "Choices"
        : "Profiles";
  return renderResponsiveManagerFooter(width, [
    [
      `${enter} ${edit}`,
      "m Model · e Reasoning · r Run with",
      "a Actions · + Add · p Sets · ? Help",
      `${escape} ${back}`,
    ],
    [`${enter} ${edit}`, "m Model · a Actions · p Sets · ? Help", `${escape} ${back}`],
    [`${enter} ${edit}`, "a Actions · ? Help", `${escape} ${back}`],
    [enter, "? Help", escape],
  ]);
};

const compactBody = (
  state: ProfileWorkspaceRenderState,
  theme: Theme,
  height: number,
  width: number,
  keys: ProfileWorkspaceKeys,
): ReadonlyArray<string> => {
  const profile = selectedProfile(state);
  const selected =
    state.pane === "profiles"
      ? `${profile} · ${profileRouteDraftSummary(profile, state.draft, state.parentEffort, state.parentModel)}`
      : state.pane === "candidates"
        ? state.draft.candidates[state.candidateIndex]
          ? candidateRow(state, profile, state.candidateIndex, true)
          : `Profile disabled · ${keys.confirm} to fix`
        : (() => {
            const row = fieldRows(state)[state.fieldIndex] ?? fieldRows(state)[0];
            return row ? `${row.label.trim()} · ${row.value}` : "No settings to edit";
          })();
  const rows = [
    theme.fg("accent", theme.bold(selected)),
    ...wrapped(theme.fg("muted", profileDescription(profile)), width),
  ];
  return rows.slice(0, height);
};

export const renderProfileWorkspace = (
  state: ProfileWorkspaceRenderState,
  options: ProfileWorkspaceRenderOptions,
): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => " ".repeat(width));
  const theme = options.theme;
  const frame = listDetailFrame(theme);
  const inner = width - 2;
  const keys = profileWorkspaceKeys(options.keybindingLabel);
  const confirmationKeys = profileWorkspaceKeys(options.keybindingLabel, true);
  const saved = state.message?.kind === "success" ? `${theme.fg("muted", "Saved")} · ` : "";
  const heading = truncateToWidth(` ${saved}${workspaceHeading(state)} `, inner, "");
  const bottom = truncateToWidth(footer(state, inner, options.keybindingLabel), inner, "");
  return framedScreen(frame, {
    width,
    height,
    top: heading,
    bottom,
    body: (bodyHeight) => {
      const noticeLines = notices(state, theme, inner, bodyHeight, confirmationKeys);
      if (bodyHeight <= 6) {
        const rows =
          state.pendingConfirmation || (state.message && state.message.kind !== "success")
            ? noticeLines
            : compactBody(state, theme, bodyHeight, inner, keys);
        return framedFill(frame, rows, bodyHeight, inner);
      }
      const available = Math.max(0, bodyHeight - noticeLines.length);
      const layout = managerLayoutTier(width);
      if (layout === "narrow") {
        const detail = pageRows(state, theme, available, inner, keys).detail;
        const rows = [...noticeLines, ...detail].slice(0, bodyHeight);
        return framedFill(frame, rows, bodyHeight, inner);
      }
      if (layout === "wide") {
        const naturalList =
          state.pane === "profiles"
            ? profileList(state, theme, PROFILE_IDS.length + 1)
            : state.pane === "candidates"
              ? state.draft.candidates.map((_candidate, index) =>
                  candidateRow(state, selectedProfile(state), index, false),
                )
              : (() => {
                  const rows = fieldRows(state);
                  const labels = Math.max(...rows.map((row) => visibleWidth(row.label)));
                  return [
                    " ".repeat(labels + 4) +
                      (state.draft.candidates[state.candidateIndex]?.model ?? ""),
                  ];
                })();
        const desired = Math.max(30, ...naturalList.map((row) => visibleWidth(row)));
        const geometry = wideListDetailGeometry(
          width,
          30,
          Math.min(0.5, Math.max(0.34, desired / inner)),
        );
        const rows = pageRows(state, theme, available, geometry.detailWidth, keys);
        return [
          ...framedFill(frame, noticeLines, noticeLines.length, inner),
          ...framedWideRows(frame, {
            left: rows.list,
            right: rows.detail,
            height: available,
            listWidth: geometry.listWidth,
            detailWidth: geometry.detailWidth,
          }),
        ];
      }
      const listHeight = stackedListHeight(
        available,
        state.pane === "profiles"
          ? PROFILE_IDS.length
          : state.pane === "candidates"
            ? Math.max(1, state.draft.candidates.length)
            : fieldRows(state).length,
      );
      const detailHeight = Math.max(0, available - listHeight - 1);
      const rows = pageRows(state, theme, listHeight, inner, keys);
      return [
        ...framedFill(frame, noticeLines, noticeLines.length, inner),
        ...framedStackedRows(frame, {
          list: rows.list.slice(0, listHeight),
          detail: rows.detail.slice(0, detailHeight),
          height: available,
          inner,
        }),
      ];
    },
  });
};
