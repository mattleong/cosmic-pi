import type { ProfileSettingsInspection } from "./profile-route-editor.ts";

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
