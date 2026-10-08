import type { ProfileSettingsInspection } from "./profile-route-editor.ts";

/** A saved scope's write guard: the exact document it was inspected with, and current trust. */
export const profileSetPatchBase = (
  inspection: ProfileSettingsInspection,
  scope: "global" | "project",
  projectTrusted: boolean,
) => {
  const expectedDocument = inspection[`${scope}Document` as const];
  return {
    scope,
    expectedExists: expectedDocument !== undefined,
    ...(expectedDocument !== undefined && { expectedDocument }),
    projectTrusted,
  };
};
