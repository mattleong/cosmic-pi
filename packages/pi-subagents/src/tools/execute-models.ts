import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { hostProfileEnvironment } from "../boundary/host-profile-resolution.ts";
import type { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentParentContext } from "../run/model.ts";
import { customAgentCandidate, type CustomAgent } from "../profiles/agents.ts";
import {
  profileCandidateLabel,
  PROFILE_IDS,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import type { ProfileResolution } from "../profiles/resolve.ts";
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
            `${entry.name ?? "all agents"} · invalid ${entry.scope} configuration · fails closed`,
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
      "Each candidate lists runtime/model, effort, context, write intent, and fast mode.",
      "Static eligibility only · executable, authentication, integration, and private-harness checks run at launch.",
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
    const attempt = Option.getOrUndefined(
      Arr.findFirst(attempts, (value) => value.candidateIndex === index),
    );
    const omitted = Option.getOrUndefined(
      Arr.findFirst(resolution.skippedCandidates, (value) => value.candidateIndex === index),
    );
    return Object.assign({}, candidate, {
      status: attempt ? ("eligible" as const) : ("skipped" as const),
      reason: attempt
        ? "Candidate adapter is statically eligible before native authentication/integration/harness readiness."
        : (omitted?.reason ?? "Candidate was not eligible."),
    });
  });
};

// An agent's candidates show its overrides; one its overrides don't fit stays as declared.
const agentCandidates = (
  candidates: ReadonlyArray<ProfileCandidate>,
  agent: CustomAgent,
): ReadonlyArray<ProfileCandidate> =>
  Arr.map(candidates, (candidate) => {
    const applied = customAgentCandidate(candidate, agent);
    return applied.kind === "eligible" ? applied.candidate : candidate;
  });

const agentView = (
  {
    name,
    description,
    profile,
    source,
    effort,
    context,
    writeIntent,
    isolation,
    tools,
  }: CustomAgent,
  candidates: ReadonlyArray<ProfileCandidateDiscovery>,
): SubagentAgentView => ({
  name,
  description,
  profile,
  source,
  ...(effort !== undefined && { effort }),
  ...(context !== undefined && { context }),
  ...(writeIntent !== undefined && { writeIntent }),
  ...(isolation !== undefined && { isolation }),
  ...(tools !== undefined && { tools }),
  candidates,
});

export const executeModelsAction = Effect.fn("SubagentTools.models")(function* (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parentContext?: SubagentParentContext,
): Effect.fn.Return<AgentToolResult<unknown>, InvalidSubagentRequestError, SubagentProfileService> {
  const profileService = yield* SubagentProfileService;
  const snapshot = yield* profileService.capture;
  const { fallbackProfile } = snapshot.effectiveConfig;
  const ids: ReadonlyArray<ProfileId> = input.profile ? [input.profile] : PROFILE_IDS;
  const environment = yield* hostProfileEnvironment(pi, ctx, parentContext);
  const profiles: ReadonlyArray<SubagentProfileView> = Arr.flatMap(ids, (id) => {
    const definition = profileService.definition(id);
    if (!definition) return [];
    const route = snapshot.effectiveConfig.profiles[definition.id];
    const resolution = profileService.resolve(snapshot, definition.id, environment);
    const candidates = candidateDiscovery(route.candidates, resolution);
    return [
      {
        id: definition.id,
        description: definition.description,
        source: snapshot.effectiveConfig.profileSources[definition.id],
        isDefault: definition.id === fallbackProfile,
        defaultContext: definition.defaultContext,
        defaultWriteIntent: definition.defaultWriteIntent,
        ...(definition.defaultEffort !== undefined && {
          defaultEffort: definition.defaultEffort,
        }),
        candidates,
      } satisfies SubagentProfileView,
    ];
  });
  const agents: ReadonlyArray<SubagentAgentView> = Fn.pipe(
    snapshot.effectiveConfig.agents,
    Arr.filter((agent) => ids.includes(agent.profile)),
    Arr.map((agent) =>
      agentView(
        agent,
        candidateDiscovery(
          agentCandidates(snapshot.effectiveConfig.profiles[agent.profile].candidates, agent),
          profileService.resolve(snapshot, agent.profile, environment, agent),
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
    details: modelDetails({ profiles, agents, invalidAgents, fallbackProfile }),
    structuredContent: encodeSubagentContract(
      modelsContract(profiles, fallbackProfile, agents, invalidAgents),
    ),
  };
});
