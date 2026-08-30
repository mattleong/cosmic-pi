import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type {
  CandidateUpdate,
  ProfileRouteDraft,
  ProfileSettingsInspection,
  ProfileSettingsScope,
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
  type ProfileWorkspaceDraftAction,
} from "./profile-workspace-actions.ts";
import { SearchableSelectPage, type SettingsSelectKeybindingId } from "./searchable-select-page.ts";

interface SharedSelectorOptions {
  readonly theme: Theme;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: SettingsSelectKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
}

const targetLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session"
    ? "Current Session"
    : `Saved set · ${target.set.scope === "project" ? "Project" : "Global"}/${target.set.name} · Current Session unchanged`;

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
  readonly select: (update: CandidateUpdate, description: string, value: string) => void;
  readonly cancel: (label: string) => void;
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
  const pageOptions = {
    theme: options.theme,
    breadcrumb: `/subagents profiles › ${options.profile} › ${profileRouteOptionLabel(options.candidateIndex)} › ${label}`,
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
          label: `${choice.label}${choice.value === current ? " (current)" : ""}`,
          description: choice.description,
        },
        searchText: `${choice.value} ${choice.label} ${choice.description}`,
        payload: choice.value,
      }),
    ),
    current,
    emptyText: "No matching values",
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: (value: string) =>
      options.select(
        selectCandidateField(options.candidate, options.field, value, changeOptions),
        `${label} changed`,
        value,
      ),
    cancel: () => options.cancel(label),
  };
  return new SearchableSelectPage<string>(
    options.notice ? { ...pageOptions, notice: options.notice } : pageOptions,
  );
};

export interface RouteActionsSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly scope: ProfileSettingsScope;
  readonly hasOwnDeclaration: boolean;
  readonly target: ProfileWorkspaceTarget;
  readonly select: (action: ProfileWorkspaceDraftAction, destructive: boolean) => void;
  readonly cancel: () => void;
}

export const makeRouteActionsSelector = (
  options: RouteActionsSelectorOptions,
): SearchableSelectPage<string> => {
  const choices = profileWorkspaceActionChoices(options);
  return new SearchableSelectPage<string>({
    theme: options.theme,
    breadcrumb: `/subagents profiles › ${options.profile} › Actions`,
    title: "Profile actions",
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
      if (choice) options.select(choice.action, choice.destructive);
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
  const pageOptions = {
    theme: options.theme,
    breadcrumb: "/subagents profiles › search",
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
    initialSearchMode: true,
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
  };
  return new SearchableSelectPage<string>(
    options.initialQuery ? { ...pageOptions, initialQuery: options.initialQuery } : pageOptions,
  );
};
