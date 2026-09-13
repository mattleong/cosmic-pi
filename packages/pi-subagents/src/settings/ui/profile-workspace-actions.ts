import { MAX_PROFILE_CANDIDATES, type ProfileId } from "../../profiles/model.ts";
import {
  addRouteCandidate,
  defaultRouteCandidate,
  disableRouteDraft,
  duplicateRouteCandidate,
  inheritProjectDraft,
  inheritSessionDraft,
  moveRouteCandidate,
  removeRouteCandidate,
  resetGlobalDraft,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
  type ProfileSettingsScope,
} from "../profile-route-editor.ts";
import type { ProfileWorkspaceConfirmation } from "./profile-workspace-render.ts";

export type ProfileWorkspaceDraftAction =
  | "add"
  | "clone"
  | "move-up"
  | "move-down"
  | "remove"
  | "disable"
  | "reset";

export interface ProfileWorkspaceActionChoice {
  readonly action: ProfileWorkspaceDraftAction;
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
}

export const profileWorkspaceActionChoices = (input: {
  readonly draft: ProfileRouteDraft;
  readonly candidateIndex: number;
  readonly scope: ProfileSettingsScope;
  readonly hasOwnDeclaration: boolean;
  readonly canUndo?: boolean | undefined;
}): ReadonlyArray<ProfileWorkspaceActionChoice> => {
  const count = input.draft.candidates.length;
  const resetAvailable = input.canUndo === true;
  return [
    ...(count < MAX_PROFILE_CANDIDATES
      ? [
          {
            action: "add" as const,
            label: count === 0 ? "Add Primary" : "Add fallback",
            description:
              count === 0
                ? "Add the first choice for this profile"
                : "Add a fallback after the existing choices",
            destructive: false,
          },
        ]
      : []),
    ...(count > 0 && count < MAX_PROFILE_CANDIDATES
      ? [
          {
            action: "clone" as const,
            label: "Duplicate",
            description: "Insert the copy after the selected choice",
            destructive: false,
          },
        ]
      : []),
    ...(count > 1 && input.candidateIndex > 0
      ? [
          {
            action: "move-up" as const,
            label: "Move up",
            description: "Move the selected choice earlier in the order",
            destructive: false,
          },
        ]
      : []),
    ...(count > 1 && input.candidateIndex < count - 1
      ? [
          {
            action: "move-down" as const,
            label: "Move down",
            description: "Move the selected choice later in the order",
            destructive: false,
          },
        ]
      : []),
    ...(count > 0
      ? [
          {
            action: "remove" as const,
            label: "Delete",
            description: "Remove it and keep the remaining choices in order",
            destructive: true,
          },
        ]
      : []),
    ...(resetAvailable
      ? [
          {
            action: "reset" as const,
            label: "Undo changes",
            description: "Restore this profile to the start of this editing visit",
            destructive: true,
          },
        ]
      : []),
  ];
};

export type ProfileWorkspaceDraftActionResult =
  | {
      readonly draft: ProfileRouteDraft;
      readonly description: string;
      readonly candidateIndex: number;
    }
  | { readonly error: string }
  | { readonly unchanged: true };

export const applyProfileWorkspaceDraftAction = (input: {
  readonly action: ProfileWorkspaceDraftAction;
  readonly draft: ProfileRouteDraft;
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly scope: ProfileSettingsScope;
  readonly inspection: ProfileSettingsInspection;
  readonly hasOwnDeclaration: boolean;
}): ProfileWorkspaceDraftActionResult => {
  if (input.action === "add") {
    if (input.draft.candidates.length >= MAX_PROFILE_CANDIDATES)
      return {
        error: `A profile can have at most ${MAX_PROFILE_CANDIDATES} Primary/Fallback choices.`,
      };
    const draft = addRouteCandidate(input.draft, defaultRouteCandidate(input.profile));
    return draft
      ? {
          draft,
          description: input.draft.candidates.length === 0 ? "Primary added" : "fallback added",
          candidateIndex: draft.candidates.length - 1,
        }
      : { unchanged: true };
  }
  if (input.action === "clone") {
    const draft = duplicateRouteCandidate(input.draft, input.candidateIndex);
    return draft
      ? {
          draft,
          description: "selected choice copied",
          candidateIndex: Math.min(input.candidateIndex + 1, draft.candidates.length - 1),
        }
      : {
          error: `A profile can have at most ${MAX_PROFILE_CANDIDATES} Primary/Fallback choices.`,
        };
  }
  if (input.action === "move-up" || input.action === "move-down") {
    const direction = input.action === "move-up" ? "up" : "down";
    const draft = moveRouteCandidate(input.draft, input.candidateIndex, direction);
    return draft === input.draft
      ? { unchanged: true }
      : {
          draft,
          description: `selected choice moved ${direction}`,
          candidateIndex: direction === "up" ? input.candidateIndex - 1 : input.candidateIndex + 1,
        };
  }
  if (input.action === "remove") {
    if (!input.draft.candidates[input.candidateIndex]) return { unchanged: true };
    return {
      draft: removeRouteCandidate(input.draft, input.candidateIndex),
      description: "selected choice removed",
      candidateIndex: Math.max(0, input.candidateIndex - 1),
    };
  }
  if (input.action === "disable")
    return input.draft.kind === "disabled"
      ? { unchanged: true }
      : { draft: disableRouteDraft(), description: "profile disabled", candidateIndex: 0 };
  if (!input.hasOwnDeclaration) return { unchanged: true };
  return {
    draft:
      input.scope === "global"
        ? resetGlobalDraft(input.profile)
        : input.scope === "project"
          ? inheritProjectDraft(input.inspection, input.profile)
          : inheritSessionDraft(input.inspection, input.profile),
    description:
      input.scope === "session"
        ? "Current Session changes undone"
        : "saved profile settings removed",
    candidateIndex: 0,
  };
};

export const profileWorkspaceConfirmation = (input: {
  readonly action: "remove" | "disable" | "reset";
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidateCount: number;
  readonly scope: ProfileSettingsScope;
  readonly currentSummary?: string | undefined;
  readonly afterSummary?: string | undefined;
}): ProfileWorkspaceConfirmation => {
  if (input.action === "remove")
    return {
      preview: input.currentSummary ? [input.currentSummary] : undefined,
      title: `Remove ${input.candidateIndex === 0 ? "Primary" : `Fallback ${input.candidateIndex}`} from ${input.profile}?`,
      detail:
        input.candidateCount === 1
          ? input.scope === "session"
            ? "This disables the profile for new runs in Current Session. Active runs do not change."
            : "This disables the profile in this saved set. Current Session does not change."
          : input.scope === "session"
            ? "This removes the selected choice for new runs in Current Session. The remaining choices keep their order. Active runs do not change."
            : "This removes the selected choice from this saved set. The remaining choices keep their order. Current Session does not change.",
    };
  if (input.action === "disable")
    return {
      title: `Disable ${input.profile}?`,
      detail:
        input.scope === "session"
          ? "New runs cannot use this profile in Current Session. Active runs do not change."
          : "This profile will be disabled in this saved set. Current Session does not change.",
    };
  const base = {
    title:
      input.scope === "session"
        ? `Undo changes to ${input.profile}?`
        : `Remove ${input.profile} settings from this saved set?`,
    detail:
      input.scope === "session"
        ? "This discards changes made to this profile in Current Session. Active runs do not change."
        : input.scope === "project"
          ? "When this saved set is used, this profile will use the Global default, or the built-in default if none is set. Current Session does not change."
          : "When this saved set is used, this profile will use the built-in default. Current Session does not change.",
  };
  if (!input.currentSummary || !input.afterSummary) return base;
  return {
    ...base,
    preview:
      input.scope === "session"
        ? [`Current     ${input.currentSummary}`, `After undo  ${input.afterSummary}`]
        : [`Current settings ${input.currentSummary}`, `After removal    ${input.afterSummary}`],
  };
};
