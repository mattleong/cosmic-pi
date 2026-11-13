import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import {
  profileRouteOptionLabel,
  type CandidateUpdate,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "../profile-route-editor.ts";
import {
  candidateFieldChoices,
  candidateFieldRows,
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
  type SearchableSelectPageChoice,
} from "pi-cosmic-ui/manager/searchable-select";
import { findOrUndefined } from "pi-cosmic-core/array";

interface SharedSelectorOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
}

export const selectHost = ({
  theme,
  getHeight,
  requestRender,
  matchesKeybinding,
  keybindingLabel,
}: SharedSelectorOptions): SharedSelectorOptions => ({
  theme,
  getHeight,
  requestRender,
  matchesKeybinding,
  keybindingLabel,
});

export const selectChoice = <A>(
  value: string,
  label: string,
  description: string,
  payload: A,
  searchText = `${value} ${label} ${description}`,
): SearchableSelectPageChoice<A> => ({
  value,
  item: { value, label, description },
  searchText,
  payload,
});

export const shortTargetLabel = (target: ProfileWorkspaceTarget): string =>
  target.kind === "session" ? "Current session" : qualifiedProfileSetLabel(target.set);

/** A picker's place in the editor, such as `Current session › reviewer › Primary › Model`. */
export const profileBreadcrumb = (...parts: ReadonlyArray<string>): string =>
  Arr.join(parts, " › ");

interface CandidateFieldSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly field: SelectableCandidateField;
  readonly target: ProfileWorkspaceTarget;
  readonly parentModel?: string | undefined;
  readonly parentEffort: SubagentEffort;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable?: boolean | undefined;
  readonly notice?: string | undefined;
  readonly select: (update: CandidateUpdate) => void;
  readonly cancel: () => void;
}

const currentFieldValue = (candidate: ProfileCandidate, field: SelectableCandidateField): string =>
  field === "openaiFastMode" ? String(candidate[field]) : candidate[field];

export const candidateFieldSelector = (
  options: CandidateFieldSelectorOptions,
): SearchableSelectPage<string> => {
  const row = findOrUndefined(
    candidateFieldRows(
      options.candidate,
      options.profile,
      options.parentEffort,
      options.parentModel,
      true,
    ),
    (entry) => entry.field === options.field,
  );
  const label = row === undefined ? options.field : Str.trim(row.label);
  const current = currentFieldValue(options.candidate, options.field);
  const changeOptions = {
    supportedEfforts: options.supportedEfforts,
    fastModeAvailable: options.fastModeAvailable,
    profile: options.profile,
    parentEffort: options.parentEffort,
  };
  return new SearchableSelectPage<string>({
    ...selectHost(options),
    breadcrumb: profileBreadcrumb(
      shortTargetLabel(options.target),
      options.profile,
      profileRouteOptionLabel(options.candidateIndex),
      label,
    ),
    title: `Choose ${Str.toLowerCase(label)}`,
    // The list marks the current value, and the pane heading names the profile.
    subtitle: profileRouteOptionLabel(options.candidateIndex),
    choices: Arr.map(candidateFieldChoices(options.field, changeOptions), (choice) =>
      selectChoice(choice.value, choice.label, choice.description, choice.value),
    ),
    current,
    markedValue: current,
    notice: options.notice,
    emptyText: "No matching values",
    select: (value: string) =>
      options.select(selectCandidateField(options.candidate, options.field, value, changeOptions)),
    cancel: options.cancel,
  });
};

interface RouteActionsSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly draft: ProfileRouteDraft;
  readonly target: ProfileWorkspaceTarget;
  readonly select: (action: CandidateMenuAction) => void;
  readonly cancel: () => void;
}

export const routeActionsSelector = (
  options: RouteActionsSelectorOptions,
): SearchableSelectPage<CandidateMenuAction> =>
  new SearchableSelectPage<CandidateMenuAction>({
    ...selectHost(options),
    breadcrumb: profileBreadcrumb(
      shortTargetLabel(options.target),
      options.profile,
      profileRouteOptionLabel(options.candidateIndex),
      "Actions",
    ),
    title: `Manage ${profileRouteOptionLabel(options.candidateIndex)}`,
    subtitle: "",
    choices: Arr.map(profileWorkspaceActionChoices(options), (choice) =>
      selectChoice(choice.action, choice.label, choice.description, choice.action),
    ),
    current: "",
    emptyText: "No actions are available",
    select: options.select,
    cancel: options.cancel,
  });

interface ProfileSearchSelectorOptions extends SharedSelectorOptions {
  readonly inspection: ProfileSettingsInspection;
  readonly current: ProfileId;
  readonly target: ProfileWorkspaceTarget;
  readonly parentModel?: string | undefined;
  readonly select: (profile: ProfileId) => void;
  readonly cancel: () => void;
}

export const profileSearchSelector = (
  options: ProfileSearchSelectorOptions,
): SearchableSelectPage<ProfileId> =>
  new SearchableSelectPage<ProfileId>({
    ...selectHost(options),
    breadcrumb: profileBreadcrumb(shortTargetLabel(options.target), "Search"),
    title: "Search profiles",
    subtitle: "",
    choices: Arr.map(PROFILE_IDS, (profile) => {
      const summary = targetProfilePrimarySummary(
        options.inspection,
        options.target,
        profile,
        options.parentModel,
      );
      return selectChoice(
        profile,
        `${profile}${profile === "generalist" ? " · used when no profile is chosen" : ""}`,
        summary,
        profile,
        `${profile} ${PROFILE_DEFINITIONS[profile].description} ${summary}`,
      );
    }),
    current: options.current,
    initialSearchMode: true,
    cancelBehavior: "close",
    emptyText: "No matching profiles",
    select: options.select,
    cancel: options.cancel,
  });
