import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import type { ProfileSettingsInspection } from "./profile-route-editor.ts";
export const profileSetPatchBase = (
  inspection: ProfileSettingsInspection,
  scope: "global" | "project",
  projectTrusted: boolean,
) => {
  const expectedDocument =
    scope === "global" ? inspection.globalDocument : inspection.projectDocument;
  return {
    scope,
    expectedExists: expectedDocument !== undefined,
    ...(expectedDocument !== undefined && { expectedDocument }),
    projectTrusted,
  };
};

export const captureProjectWriteTrust = (
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  message: string,
): { readonly projectTrusted: boolean } | undefined => {
  const projectTrusted = isProjectTrusted(ctx);
  if (scope === "project" && !projectTrusted) {
    ctx.ui.notify(message, "warning");
    return undefined;
  }
  return { projectTrusted };
};
