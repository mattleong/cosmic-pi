import type { SubagentEffort } from "../../domain/routing.ts";
import type { ProfileId } from "../../profiles/model.ts";
import type { ProfileRouteDraft } from "../profile-route-editor.ts";
import { candidateFieldRows, type ProfileWorkspaceFieldRow } from "./profile-workspace-model.ts";

export interface ProfileWorkspaceRow extends ProfileWorkspaceFieldRow {
  readonly candidateIndex: number;
}

/** One selectable sequence across all candidate sections. Section headings are not stops. */
export const profileWorkspaceRows = (
  draft: ProfileRouteDraft,
  profile: ProfileId,
  parentEffort: SubagentEffort,
  parentModel: string | undefined,
  expanded: ReadonlySet<number>,
  session = false,
): ReadonlyArray<ProfileWorkspaceRow> => [
  ...(draft.candidates.length === 0
    ? [
        {
          candidateIndex: 0,
          field: "model" as const,
          label: "Add model",
          value: "enable this profile",
          fixed: false,
        },
        {
          candidateIndex: 0,
          field: "actions" as const,
          label: "Actions",
          value: "manage profile",
          fixed: false,
        },
      ]
    : draft.candidates.flatMap((candidate, candidateIndex) =>
        candidateFieldRows(
          candidate,
          profile,
          parentEffort,
          parentModel,
          expanded.has(candidateIndex),
          { index: candidateIndex, count: draft.candidates.length },
        ).map((row) => ({ ...row, candidateIndex })),
      )),
  ...(session
    ? [
        {
          candidateIndex: Math.max(0, draft.candidates.length - 1),
          field: "save-session" as const,
          label: "Save these profiles as a set",
          value: "",
          fixed: false,
        },
      ]
    : []),
];
