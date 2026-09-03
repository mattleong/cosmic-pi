// The subagent_models action: static profile-route discovery and its tool result.
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { hostProfileEnvironment } from "../boundary/host-profile-resolution.ts";
import {
  normalizeProfileId,
  profileCandidateLabel,
  PROFILE_IDS,
  type ProfileId,
} from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import { makeCompactToolDetails } from "./details.ts";
import { boundToolOutput } from "./format.ts";
import type { ProfileCandidateDiscovery, SubagentProfileView } from "./model.ts";
import type { SubagentModelsInput } from "./schema.ts";

const formatProfileDiscovery = (
  profiles: ReadonlyArray<SubagentProfileView>,
  fallbackProfile: ProfileId,
): string =>
  [
    "Profile routes · static preflight",
    `Profile omitted → ${fallbackProfile}`,
    "Each candidate lists host/runtime/model, effort, context, write intent, fast mode, and retention.",
    "Static eligibility only · executable, authentication, integration, and private-harness checks run at launch.",
    "",
    ...profiles.flatMap((profile) => [
      `${profile.id}${profile.isDefault ? " · when omitted" : ""} — ${profile.description}`,
      `  source=${profile.source} · defaults: context=${profile.defaultContext} · intent=${profile.defaultWriteIntent} · effort=${profile.defaultEffort ?? "inherit"}`,
      ...(profile.candidates.length > 0
        ? profile.candidates.map(
            (candidate, index) =>
              `  ${index + 1}. ${profileCandidateLabel(candidate)} · ${candidate.status}\n     ${candidate.reason}`,
          )
        : ["  disabled · no candidates"]),
      "",
    ]),
  ].join("\n");

/** The subagent_models action owner: static profile-route discovery, its formatted
 * text, and the compact details projection. */
export const executeModelsAction = (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Effect.Effect<AgentToolResult<unknown>, never, SubagentProfileService> =>
  Effect.gen(function* () {
    const profileService = yield* SubagentProfileService;
    const snapshot = yield* profileService.capture;
    const requestedProfile = input.profile ? normalizeProfileId(input.profile) : undefined;
    const ids = input.profile ? (requestedProfile ? [requestedProfile] : []) : PROFILE_IDS;
    const environment = hostProfileEnvironment(pi, ctx);
    const profiles: ReadonlyArray<SubagentProfileView> = ids.flatMap((id) => {
      const definition = profileService.definition(id);
      if (!definition) return [];
      const route = snapshot.effectiveConfig.profiles[definition.id];
      const resolution = profileService.resolve(snapshot, definition.id, environment);
      const attempts = resolution.kind === "resolved" ? resolution.attempts : [];
      const skipped = resolution.skippedCandidates;
      const candidates: ProfileCandidateDiscovery[] = route.candidates.map((candidate, index) => {
        const attempt = attempts.find((value) => value.candidateIndex === index);
        const omitted = skipped.find((value) => value.candidateIndex === index);
        return {
          ...candidate,
          status: attempt ? "eligible" : "skipped",
          reason: attempt
            ? "Candidate adapter is statically eligible before native authentication/integration/harness readiness."
            : (omitted?.reason ?? "Candidate was not eligible."),
        };
      });
      return [
        {
          id: definition.id,
          description: definition.description,
          source: snapshot.effectiveConfig.profileSources[definition.id],
          isDefault: definition.id === "generalist",
          defaultContext: definition.defaultContext,
          defaultWriteIntent: definition.defaultWriteIntent,
          ...(definition.defaultEffort !== undefined && {
            defaultEffort: definition.defaultEffort,
          }),
          candidates,
        } satisfies SubagentProfileView,
      ];
    });
    return {
      content: [
        {
          type: "text" as const,
          text: boundToolOutput(
            formatProfileDiscovery(profiles, snapshot.effectiveConfig.fallbackProfile),
          ),
        },
      ],
      details: makeCompactToolDetails({
        action: "models",
        profiles,
        fallbackProfile: snapshot.effectiveConfig.fallbackProfile,
      }),
    };
  });
