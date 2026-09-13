import type { SubagentEffort } from "../../domain/routing.ts";
import { MAX_PROFILE_CANDIDATES, type ProfileId } from "../../profiles/model.ts";
import type { ProfileRouteDraft } from "../profile-route-editor.ts";
import { candidateFieldRows, type ProfileWorkspaceFieldRow } from "./profile-workspace-model.ts";

export type ProfileWorkspaceRow = ProfileWorkspaceFieldRow &
  (
    | { readonly scope: "candidate"; readonly candidateIndex: number }
    | { readonly scope: "profile"; readonly candidateIndex?: undefined }
  );

/** Headings and section spacing are presentation, never keyboard navigation stops. */
export const profileWorkspaceRows = (
  draft: ProfileRouteDraft,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  parentModel: string | undefined,
  expanded: ReadonlySet<number>,
  canUndo = false,
): ReadonlyArray<ProfileWorkspaceRow> => [
  ...draft.candidates.flatMap((candidate, candidateIndex) =>
    candidateFieldRows(
      candidate,
      profile,
      parentEffort,
      parentModel,
      expanded.has(candidateIndex),
      { index: candidateIndex, count: draft.candidates.length },
    ).map((row): ProfileWorkspaceRow => ({ ...row, scope: "candidate", candidateIndex })),
  ),
  {
    scope: "profile",
    field: draft.candidates.length === 0 ? "model" : "add",
    label: draft.candidates.length === 0 ? "Add model…" : "Add fallback…",
    value:
      draft.kind === "invalid"
        ? "repair this profile"
        : draft.kind === "disabled"
          ? "enable this profile"
          : "",
    fixed: draft.candidates.length >= MAX_PROFILE_CANDIDATES,
    fixedReason: "The 32-candidate limit has been reached.",
  },
  {
    scope: "profile",
    field: "reset",
    label: "Undo changes",
    value: "",
    fixed: !canUndo,
    fixedReason: "No undoable changes from this visit.",
  },
];
