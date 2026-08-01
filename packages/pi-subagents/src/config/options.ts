import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  PROFILE_IDS,
  type DeclaredProfileCandidate,
  type DeclaredProfileRoute,
  type ProfileCandidate,
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
  readonly defaultProfile: ProfileId;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  readonly diagnostics: ReadonlyArray<string>;
}

const normalizeCandidate = (candidate: DeclaredProfileCandidate): ProfileCandidate => ({
  ...candidate,
  fastMode: candidate.fastMode ?? false,
  closeOnReport: candidate.closeOnReport ?? true,
});

const normalizeRoute = (route: DeclaredProfileRoute): ProfileRoute => {
  if (route === "disabled") return { candidates: [] };
  const candidates = Array.isArray(route)
    ? (route as ReadonlyArray<DeclaredProfileCandidate>)
    : [route as DeclaredProfileCandidate];
  return { candidates: candidates.map(normalizeCandidate) };
};

const cloneRoute = (route: ProfileRoute): ProfileRoute => ({
  candidates: route.candidates.map((candidate) => ({ ...candidate })),
});

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
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    if (project?.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "project-invalid";
    } else if (project?.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeRoute(project.file.profiles[id]);
      profileSources[id] = "project";
    } else if (input.global.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "global-invalid";
    } else if (input.global.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeRoute(input.global.file.profiles[id]);
      profileSources[id] = "global";
    } else {
      profiles[id] = cloneRoute(BUILTIN_PROFILE_ROUTES[id]);
      profileSources[id] = "builtin";
    }
  }
  return freezeSnapshot({
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    projectTrusted: input.projectTrusted,
    globalConfigExists: input.globalConfigExists,
    projectConfigExists: input.projectTrusted && input.projectConfigExists,
    defaultProfile:
      project?.file.defaultProfile ?? input.global.file.defaultProfile ?? ("generalist" as const),
    profiles,
    profileSources,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}
