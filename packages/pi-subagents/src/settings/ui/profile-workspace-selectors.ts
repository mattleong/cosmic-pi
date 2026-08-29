import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROFILE_DEFINITIONS } from "../../profiles/definitions.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type { CandidateUpdate, ProfileSettingsInspection } from "../profile-route-editor.ts";
import {
  candidateFieldChoices,
  candidateFieldRows,
  effectiveProfileSummary,
  selectCandidateField,
  type ProfileWorkspaceField,
} from "./profile-workspace-model.ts";
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

export interface CandidateFieldSelectorOptions extends SharedSelectorOptions {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly field: Exclude<ProfileWorkspaceField, "model">;
  readonly fieldIndex: number;
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
  field: Exclude<ProfileWorkspaceField, "model">,
): string =>
  field === "closeOnReport" || field === "openaiFastMode"
    ? String(candidate[field])
    : candidate[field];

export const makeCandidateFieldSelector = (
  options: CandidateFieldSelectorOptions,
): SearchableSelectPage<string> => {
  const row = candidateFieldRows(
    options.candidate,
    options.profile,
    options.parentEffort,
    options.parentModel,
  )[options.fieldIndex];
  const label = row?.label ?? options.field;
  const current = currentFieldValue(options.candidate, options.field);
  const changeOptions = {
    piModel: options.piModel,
    supportedEfforts: options.supportedEfforts,
    fastModeAvailable: options.fastModeAvailable,
    profile: options.profile,
    parentEffort: options.parentEffort,
  };
  return new SearchableSelectPage<string>(
    (() => {
      const baseResult = {
        theme: options.theme,
        breadcrumb: `/subagents profiles › ${options.profile} › candidate ${options.candidateIndex + 1} › ${label}`,
        title: `Choose ${label.toLowerCase()}`,
        subtitle: `${options.profile} · candidate ${options.candidateIndex + 1} · current: ${row?.value ?? current}`,
      };
      const withNotice = options.notice ? { ...baseResult, notice: options.notice } : baseResult;
      const withChoicesAndAdditionalFields = {
        ...withNotice,
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
            `${label} updated`,
            value,
          ),
        cancel: () => options.cancel(label),
      };
      return withChoicesAndAdditionalFields;
    })(),
  );
};

export interface ProfileSearchSelectorOptions extends SharedSelectorOptions {
  readonly inspection: ProfileSettingsInspection;
  readonly current: ProfileId;
  readonly parentEffort: SubagentEffort;
  readonly parentModel?: string | undefined;
  readonly initialQuery?: string | undefined;
  readonly select: (profile: ProfileId) => void;
  readonly cancel: () => void;
}

export const makeProfileSearchSelector = (
  options: ProfileSearchSelectorOptions,
): SearchableSelectPage<string> =>
  new SearchableSelectPage<string>(
    (() => {
      const baseResult = {
        theme: options.theme,
        breadcrumb: "/subagents profiles › search",
        title: "Search profiles",
        subtitle: "Choose a profile to open its effective ordered route",
        choices: PROFILE_IDS.map((profile) => ({
          value: profile,
          item: {
            value: profile,
            label: `${profile}${profile === "generalist" ? " · when omitted" : ""}`,
            description: effectiveProfileSummary(
              options.inspection,
              profile,
              options.parentEffort,
              options.parentModel,
            ),
          },
          searchText: `${profile} ${PROFILE_DEFINITIONS[profile].description} ${effectiveProfileSummary(options.inspection, profile, options.parentEffort, options.parentModel)}`,
          payload: profile,
        })),
        current: options.current,
        initialSearchMode: true,
      };
      const withInitialQuery = options.initialQuery
        ? { ...baseResult, initialQuery: options.initialQuery }
        : baseResult;
      const withEmptyTextAndAdditionalFields = {
        ...withInitialQuery,
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
      return withEmptyTextAndAdditionalFields;
    })(),
  );
