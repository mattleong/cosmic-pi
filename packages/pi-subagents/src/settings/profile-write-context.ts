import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasObjectRuntimeType, isProjectTrusted } from "pi-cosmic-core";
import { SessionProfileConflictError } from "../profiles/session-overrides.ts";
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

export const isSessionProfileConflict = <ErrorInput>(error: ErrorInput): boolean =>
  error instanceof SessionProfileConflictError ||
  (hasObjectRuntimeType(error) &&
    error !== null &&
    // SAFETY: the object guard permits reading an optional error tag.
    (error as { readonly _tag?: unknown })._tag === "SessionProfileConflictError");

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
