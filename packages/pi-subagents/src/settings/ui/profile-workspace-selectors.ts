import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type {
  CandidateUpdate,
  ProfileRouteDraft,
  ProfileSettingsInspection,
  ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateFieldChoices,
  candidateFieldRows,
  profileRouteOptionLabel,
  runWithValue,
  selectCandidateField,
  targetProfilePrimarySummary,
  type SelectableCandidateField,
} from "./profile-workspace-model.ts";
import {
  profileWorkspaceActionChoices,
  type CandidateMenuAction,
} from "./profile-workspace-actions.ts";
import { qualifiedProfileSetLabel } from "./profile-set-picker-model.ts";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
} from "pi-cosmic-ui/manager/searchable-select";

interface SharedSelectorOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
}

export const shortTargetLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session" ? "Session" : qualifiedProfileSetLabel(target.set);

const targetLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Editing Current Session"
    : `${qualifiedProfileSetLabel(target.set)} · session not affected`;

export interface CandidateFieldSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly field: SelectableCandidateField;
  readonly target: ProfileWorkspaceTarget;
  readonly piModel?: string | undefined;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable?: boolean | undefined;
  readonly notice?: string | undefined;
  readonly select: (update: CandidateUpdate) => void;
  readonly cancel: () => void;
}

const currentFieldValue = (
  candidate: ProfileCandidate,
  field: SelectableCandidateField,
): string => {
  if (field === "runWith") return runWithValue(candidate);
  return field === "closeOnReport" || field === "openaiFastMode"
    ? String(candidate[field])
    : candidate[field];
};

export const makeCandidateFieldSelector = (
  options: CandidateFieldSelectorOptions,
): SearchableSelectPage<string> => {
  const row = candidateFieldRows(
    options.candidate,
    options.profile,
    options.parentEffort,
    options.parentModel,
    true,
  ).find((entry) => entry.field === options.field);
  const label = row?.label.trim() ?? options.field;
  const current = currentFieldValue(options.candidate, options.field);
  const changeOptions = {
    piModel: options.piModel,
    supportedEfforts: options.supportedEfforts,
    fastModeAvailable: options.fastModeAvailable,
    profile: options.profile,
    parentEffort: options.parentEffort,
  };
  return new SearchableSelectPage<string>({
    theme: options.theme,
    breadcrumb: `${shortTargetLabel(options.target)} · ${options.profile} · ${profileRouteOptionLabel(options.candidateIndex)} · ${label}`,
    title:
      options.field === "closeOnReport"
        ? "Choose what happens after reporting"
        : `Choose ${label.toLowerCase()}`,
    subtitle: `${targetLabel(options.target)} · current: ${row?.value ?? current}`,
    choices: candidateFieldChoices(options.candidate, options.field, changeOptions).map(
      (choice) => ({
        value: choice.value,
        item: {
          value: choice.value,
          label: choice.label,
          description: choice.description,
        },
        searchText: `${choice.value} ${choice.label} ${choice.description}`,
        payload: choice.value,
      }),
    ),
    current,
    notice: options.notice,
    emptyText: "No matching values",
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: (value: string) =>
      options.select(selectCandidateField(options.candidate, options.field, value, changeOptions)),
    cancel: options.cancel,
  });
};

export interface RouteActionsSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly target: ProfileWorkspaceTarget;
  readonly select: (action: CandidateMenuAction) => void;
  readonly cancel: () => void;
}

export const makeRouteActionsSelector = (
  options: RouteActionsSelectorOptions,
): SearchableSelectPage<string> => {
  const choices = profileWorkspaceActionChoices(options);
  return new SearchableSelectPage<string>({
    theme: options.theme,
    breadcrumb: `${shortTargetLabel(options.target)} · ${options.profile} · ${profileRouteOptionLabel(options.candidateIndex)} · Actions`,
    title: `Manage ${profileRouteOptionLabel(options.candidateIndex)} · ${options.profile}`,
    subtitle: targetLabel(options.target),
    choices: choices.map((choice) => ({
      value: choice.action,
      item: { value: choice.action, label: choice.label, description: choice.description },
      searchText: `${choice.action} ${choice.label} ${choice.description}`,
      payload: choice.action,
    })),
    current: "",
    emptyText: "No actions are available",
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: (value: string) => {
      const choice = choices.find((entry) => entry.action === value);
      if (choice) options.select(choice.action);
    },
    cancel: options.cancel,
  });
};

export interface ProfileSearchSelectorOptions extends SharedSelectorOptions {
  readonly inspection: ProfileSettingsInspection;
  readonly current: ProfileId;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  readonly initialQuery?: string | undefined;
  readonly target: ProfileWorkspaceTarget;
  readonly select: (profile: ProfileId) => void;
  readonly cancel: () => void;
}

export const makeProfileSearchSelector = (
  options: ProfileSearchSelectorOptions,
): SearchableSelectPage<string> => {
  return new SearchableSelectPage<string>({
    theme: options.theme,
    breadcrumb: targetLabel(options.target),
    title: "Search profiles",
    subtitle: targetLabel(options.target),
    choices: PROFILE_IDS.map((profile) => {
      const summary = targetProfilePrimarySummary(options.inspection, options.target, profile);
      return {
        value: profile,
        item: {
          value: profile,
          label: `${profile}${profile === "generalist" ? " · used when no profile is chosen" : ""}`,
          description: summary,
        },
        searchText: `${profile} ${PROFILE_DEFINITIONS[profile].description} ${summary}`,
        payload: profile,
      };
    }),
    current: options.current,
    initialQuery: options.initialQuery,
    initialSearchMode: true,
    cancelBehavior: "close",
    emptyText: "No matching profiles",
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: (value: string) => {
      const profile = PROFILE_IDS.find((entry) => entry === value);
      if (profile) options.select(profile);
    },
    cancel: options.cancel,
  });
};
