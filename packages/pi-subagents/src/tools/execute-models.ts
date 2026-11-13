import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { hostProfileEnvironment } from "../boundary/host-profile-resolution.ts";
import type { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentParentContext } from "../run/model.ts";
import { customAgentCandidate, type CustomAgent } from "../profiles/agents.ts";
import {
  profileCandidateLabel,
  PROFILE_IDS,
  type ProfileCandidate,
  type ProfileDefinition,
  type ProfileId,
} from "../profiles/model.ts";
import { PROFILE_DEFINITIONS } from "../profiles/definitions.ts";
import { resolveProfilePlan, type ProfileResolution } from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import { encodeSubagentContract } from "./contract-schema.ts";
import { modelsContract } from "./discovery-contract.ts";
import { modelDetails } from "./details.ts";
import { boundToolOutput } from "./format.ts";
import type {
  ProfileCandidateDiscovery,
  SubagentAgentView,
  SubagentInvalidAgentView,
  SubagentProfileView,
} from "./model.ts";
import type { SubagentModelsInput } from "./schema.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

const candidateLines = (candidates: ReadonlyArray<ProfileCandidateDiscovery>) =>
  candidates.length > 0
    ? Arr.map(
        candidates,
        (candidate, index) =>
          `  ${index + 1}. ${profileCandidateLabel(candidate)} · ${candidate.status}\n     ${candidate.reason}`,
      )
    : ["  disabled · no candidates"];

const agentOverrides = (agent: SubagentAgentView): string =>
  Arr.join(
    [
      `profile=${agent.profile}`,
      `source=${agent.source}`,
      ...(agent.effort ? [`effort=${agent.effort}`] : []),
      ...(agent.context ? [`context=${agent.context}`] : []),
      ...(agent.writeIntent ? [`intent=${agent.writeIntent}`] : []),
      ...(agent.isolation ? [`isolation=${agent.isolation}`] : []),
      ...(agent.tools?.allow ? [`tools allow=${Arr.join(agent.tools.allow, ",") || "none"}`] : []),
      ...(agent.tools?.deny ? [`tools deny=${Arr.join(agent.tools.deny, ",") || "none"}`] : []),
    ],
    " · ",
  );

const formatAgentDiscovery = (
  agents: ReadonlyArray<SubagentAgentView>,
  invalidAgents: ReadonlyArray<SubagentInvalidAgentView>,
): ReadonlyArray<string> =>
  agents.length === 0 && invalidAgents.length === 0
    ? []
    : [
        "Custom agents · set agent instead of profile; each agent's overrides apply to its profile's candidates",
        "",
        ...Arr.flatMap(agents, (agent) => [
          `${agent.name} — ${agent.description}`,
          `  ${agentOverrides(agent)}`,
          ...candidateLines(agent.candidates),
          "",
        ]),
        ...Arr.map(
          invalidAgents,
          (entry) =>
            `${entry.name ?? "all agents"} · invalid ${entry.scope} configuration · can't start until repaired`,
        ),
      ];

const formatProfileDiscovery = (
  profiles: ReadonlyArray<SubagentProfileView>,
  fallbackProfile: ProfileId,
  agents: ReadonlyArray<SubagentAgentView>,
  invalidAgents: ReadonlyArray<SubagentInvalidAgentView>,
): string =>
  Arr.join(
    [
      "Profile routes · static preflight",
      `Profile omitted → ${fallbackProfile}`,
      "Each candidate lists model, effort, context, write intent, and fast mode.",
      "Static eligibility only · executable and authentication checks run at launch.",
      "",
      ...Arr.flatMap(profiles, (profile) => [
        `${profile.id}${profile.isDefault ? " · when omitted" : ""} — ${profile.description}`,
        `  source=${profile.source} · defaults: context=${profile.defaultContext} · intent=${profile.defaultWriteIntent} · effort=${profile.defaultEffort ?? "inherit"}`,
        ...candidateLines(profile.candidates),
        "",
      ]),
      ...formatAgentDiscovery(agents, invalidAgents),
    ],
    "\n",
  );

/** Projects each declared candidate with its static planning outcome. */
const candidateDiscovery = (
  candidates: ReadonlyArray<ProfileCandidate>,
  resolution: ProfileResolution,
): ReadonlyArray<ProfileCandidateDiscovery> => {
  const attempts = resolution.kind === "resolved" ? resolution.attempts : [];
  return Arr.map(candidates, (candidate, index) => {
    const attempt = findOrUndefined(attempts, (value) => value.candidateIndex === index);
    const omitted = findOrUndefined(
      resolution.skippedCandidates,
      (value) => value.candidateIndex === index,
    );
    return Object.assign({}, candidate, {
      status: attempt ? ("eligible" as const) : ("skipped" as const),
      reason: attempt
        ? "Candidate is statically eligible before model authentication and readiness checks."
        : (omitted?.reason ?? "Candidate was not eligible."),
    });
  });
};

// The agent's private instructions stay out of discovery.
const agentView = (
  { instructions: _instructions, ...agent }: CustomAgent,
  candidates: ReadonlyArray<ProfileCandidateDiscovery>,
): SubagentAgentView => ({ ...agent, candidates });

export const executeModelsAction = Effect.fn("SubagentTools.models")(function* (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parentContext?: SubagentParentContext,
): Effect.fn.Return<AgentToolResult<unknown>, InvalidSubagentRequestError, SubagentProfileService> {
  const snapshot = yield* (yield* SubagentProfileService).capture;
  const { fallbackProfile } = snapshot.effectiveConfig;
  const ids: ReadonlyArray<ProfileId> = input.profile ? [input.profile] : PROFILE_IDS;
  const environment = yield* hostProfileEnvironment(pi, ctx, parentContext);
  const profiles = Arr.map(ids, (id): SubagentProfileView => {
    const definition: ProfileDefinition = PROFILE_DEFINITIONS[id];
    const route = snapshot.effectiveConfig.profiles[id];
    const resolution = resolveProfilePlan(id, snapshot.effectiveConfig, environment);
    return {
      id,
      description: definition.description,
      source: snapshot.effectiveConfig.profileSources[id],
      isDefault: id === fallbackProfile,
      defaultContext: definition.defaultContext,
      defaultWriteIntent: definition.defaultWriteIntent,
      ...(definition.defaultEffort !== undefined && {
        defaultEffort: definition.defaultEffort,
      }),
      candidates: candidateDiscovery(route.candidates, resolution),
    };
  });
  const agents: ReadonlyArray<SubagentAgentView> = Fn.pipe(
    snapshot.effectiveConfig.agents,
    Arr.filter((agent) => ids.includes(agent.profile)),
    Arr.map((agent) =>
      agentView(
        agent,
        candidateDiscovery(
          // An agent's candidates show its overrides.
          Arr.map(snapshot.effectiveConfig.profiles[agent.profile].candidates, (candidate) =>
            customAgentCandidate(candidate, agent),
          ),
          resolveProfilePlan(agent.profile, snapshot.effectiveConfig, environment, agent),
        ),
      ),
    ),
  );
  const { invalidAgents } = snapshot.effectiveConfig;
  return {
    content: [
      {
        type: "text" as const,
        text: boundToolOutput(
          formatProfileDiscovery(profiles, fallbackProfile, agents, invalidAgents),
        ),
      },
    ],
    details: modelDetails({
      profiles,
      agents,
      invalidAgents,
      fallbackProfile,
      parentModel: environment.parentModel?.model,
      parentEffort: environment.parentEffort,
    }),
    structuredContent: encodeSubagentContract(
      modelsContract(profiles, fallbackProfile, agents, invalidAgents),
    ),
  };
});
