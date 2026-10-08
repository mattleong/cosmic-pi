import { MAX_PROFILE_CANDIDATES, type ProfileId } from "../../profiles/model.ts";
import {
  CANDIDATE_LIMIT_ERROR,
  duplicateRouteCandidate,
  moveRouteCandidate,
  profileRouteOptionLabel,
  removeRouteCandidate,
  type ProfileRouteDraft,
  type ProfileSettingsScope,
} from "../profile-route-editor.ts";
import type { ProfileWorkspaceConfirmation } from "./profile-workspace-render.ts";

export type CandidateMenuAction = "clone" | "move-up" | "move-down" | "remove";

const CANDIDATE_MENU_CHOICES = [
  { action: "clone", label: "Duplicate", description: "Insert the copy after the selected choice" },
  {
    action: "move-up",
    label: "Move up",
    description: "Move the selected choice earlier in the order",
  },
  {
    action: "move-down",
    label: "Move down",
    description: "Move the selected choice later in the order",
  },
  {
    action: "remove",
    label: "Delete",
    description: "Remove it and keep the remaining choices in order",
  },
] as const;

export const profileWorkspaceActionChoices = (input: {
  readonly draft: ProfileRouteDraft;
  readonly candidateIndex: number;
}) => {
  const count = input.draft.candidates.length;
  const available = {
    clone: count > 0 && count < MAX_PROFILE_CANDIDATES,
    "move-up": count > 1 && input.candidateIndex > 0,
    "move-down": count > 1 && input.candidateIndex < count - 1,
    remove: count > 0,
  } satisfies Record<CandidateMenuAction, boolean>;
  return CANDIDATE_MENU_CHOICES.filter((choice) => available[choice.action]);
};

export const applyProfileWorkspaceDraftAction = (input: {
  readonly action: CandidateMenuAction;
  readonly draft: ProfileRouteDraft;
  readonly candidateIndex: number;
}):
  | { readonly draft: ProfileRouteDraft; readonly candidateIndex: number }
  | { readonly error: string }
  | { readonly unchanged: true } => {
  if (input.action === "clone") {
    const draft = duplicateRouteCandidate(input.draft, input.candidateIndex);
    return draft
      ? { draft, candidateIndex: Math.min(input.candidateIndex + 1, draft.candidates.length - 1) }
      : { error: CANDIDATE_LIMIT_ERROR };
  }
  if (input.action === "move-up" || input.action === "move-down") {
    const direction = input.action === "move-up" ? "up" : "down";
    const draft = moveRouteCandidate(input.draft, input.candidateIndex, direction);
    return draft === input.draft
      ? { unchanged: true }
      : {
          draft,
          candidateIndex: direction === "up" ? input.candidateIndex - 1 : input.candidateIndex + 1,
        };
  }
  if (!input.draft.candidates[input.candidateIndex]) return { unchanged: true };
  return {
    draft: removeRouteCandidate(input.draft, input.candidateIndex),
    candidateIndex: Math.max(0, input.candidateIndex - 1),
  };
};

export const profileWorkspaceConfirmation = (input: {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidateCount: number;
  readonly scope: ProfileSettingsScope;
}): ProfileWorkspaceConfirmation => ({
  title: `Remove ${profileRouteOptionLabel(input.candidateIndex)} from ${input.profile}?`,
  detail:
    input.candidateCount === 1
      ? input.scope === "session"
        ? "This disables the profile for new runs in Current Session. Active runs do not change."
        : "This disables the profile in this saved set. Current Session does not change."
      : input.scope === "session"
        ? "This removes the selected choice for new runs in Current Session. The remaining choices keep their order. Active runs do not change."
        : "This removes the selected choice from this saved set. The remaining choices keep their order. Current Session does not change.",
});
