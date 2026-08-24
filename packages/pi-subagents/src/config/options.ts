import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  cloneProfileRoute,
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import type { DecodedSubagentConfig } from "./schema.ts";

export interface ResolvedSubagentConfig {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly fallbackProfile: ProfileId;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface ResolveSubagentConfigInput {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

/** Project routes replace global routes atomically; missing declarations inherit. */
export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  // SAFETY: Configuration decoding validates the persisted value before this typed access.
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    if (project?.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "project-invalid";
    } else if (project?.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeDeclaredProfileRoute(project.file.profiles[id]);
      profileSources[id] = "project";
    } else if (input.global.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "global-invalid";
    } else if (input.global.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeDeclaredProfileRoute(input.global.file.profiles[id]);
      profileSources[id] = "global";
    } else {
      profiles[id] = cloneProfileRoute(BUILTIN_PROFILE_ROUTES[id]);
      profileSources[id] = "builtin";
    }
  }
  return freezeSnapshot({
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    projectTrusted: input.projectTrusted,
    globalConfigExists: input.globalConfigExists,
    projectConfigExists: input.projectTrusted && input.projectConfigExists,
    fallbackProfile: "generalist",
    profiles,
    profileSources,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}
