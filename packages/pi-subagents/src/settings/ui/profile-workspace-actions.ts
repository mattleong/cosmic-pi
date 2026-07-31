import { MAX_PROFILE_CANDIDATES } from "../../config/schema.ts";
import type { SubagentConfigInspection, SubagentConfigScope } from "../../config/store.ts";
import type { ProfileId } from "../../profiles/model.ts";
import {
  addRouteCandidate,
  defaultRouteCandidate,
  disableRouteDraft,
  duplicateRouteCandidate,
  inheritProjectDraft,
  moveRouteCandidate,
  removeRouteCandidate,
  resetGlobalDraft,
  type ProfileRouteDraft,
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
  readonly scope: SubagentConfigScope;
  readonly inspection: SubagentConfigInspection;
}): ProfileWorkspaceDraftActionResult => {
  if (input.action === "add") {
    if (input.draft.candidates.length >= MAX_PROFILE_CANDIDATES)
      return { error: `A route may contain at most ${MAX_PROFILE_CANDIDATES} candidates.` };
    const draft = addRouteCandidate(input.draft, defaultRouteCandidate(input.profile));
    return draft
      ? { draft, description: "candidate added", candidateIndex: draft.candidates.length - 1 }
      : { unchanged: true };
  }
  if (input.action === "clone") {
    const draft = duplicateRouteCandidate(input.draft, input.candidateIndex);
    return draft
      ? {
          draft,
          description: "candidate duplicated",
          candidateIndex: Math.min(input.candidateIndex + 1, draft.candidates.length - 1),
        }
      : { error: `A route may contain at most ${MAX_PROFILE_CANDIDATES} candidates.` };
  }
  if (input.action === "move-up" || input.action === "move-down") {
    const direction = input.action === "move-up" ? "up" : "down";
    const draft = moveRouteCandidate(input.draft, input.candidateIndex, direction);
    return draft === input.draft
      ? { unchanged: true }
      : {
          draft,
          description: `candidate moved ${direction}`,
          candidateIndex: direction === "up" ? input.candidateIndex - 1 : input.candidateIndex + 1,
        };
  }
  if (input.action === "remove") {
    if (!input.draft.candidates[input.candidateIndex]) return { unchanged: true };
    return {
      draft: removeRouteCandidate(input.draft, input.candidateIndex),
      description: "candidate removed",
      candidateIndex: Math.max(0, input.candidateIndex - 1),
    };
  }
  if (input.action === "disable")
    return input.draft.kind === "disabled"
      ? { unchanged: true }
      : {
          draft: disableRouteDraft(),
          description: "route disabled",
          candidateIndex: 0,
        };
  if (
    (input.scope === "global" && input.draft.kind === "reset") ||
    (input.scope === "project" && input.draft.kind === "inherit")
  )
    return { unchanged: true };
  return {
    draft:
      input.scope === "global"
        ? resetGlobalDraft(input.profile)
        : inheritProjectDraft(input.inspection, input.profile),
    description:
      input.scope === "global" ? "profile reset to built-in" : "profile reset to inherit global",
    candidateIndex: 0,
  };
};

export const profileWorkspaceConfirmation = (input: {
  readonly action: "remove" | "disable" | "reset";
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly scope: SubagentConfigScope;
}): ProfileWorkspaceConfirmation => {
  if (input.action === "remove")
    return {
      key: "x",
      title: `Remove candidate ${input.candidateIndex + 1} from ${input.profile}?`,
      detail:
        "The remaining candidates keep their current order. The valid route is saved immediately.",
    };
  if (input.action === "disable")
    return {
      key: "d",
      title: `Disable the ${input.profile} route?`,
      detail: "No candidate will launch for this profile after reload.",
    };
  return {
    key: "i",
    title: `Reset ${input.profile}?`,
    detail:
      input.scope === "global"
        ? "The global declaration will be removed. The effective route will return to the built-in profile."
        : "The project declaration will be removed. The effective route will come from global settings.",
  };
};
