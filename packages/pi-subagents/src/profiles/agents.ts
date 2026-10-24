import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import {
  isProfileId,
  profileCandidateValidationIssues,
  type ProfileCandidate,
  type ProfileId,
} from "./model.ts";

export const MAX_CUSTOM_AGENTS = 32;
export const MAX_CUSTOM_AGENT_NAME_CHARS = 48;
/** A longer description is cut to this bound, with a diagnostic, and the agent still applies. */
export const MAX_CUSTOM_AGENT_DESCRIPTION_CHARS = 200;
/** Instructions travel in the child's system prompt, so they are bounded like a task. */
export const MAX_CUSTOM_AGENT_INSTRUCTIONS_BYTES = 128 * 1024;
export const MAX_CUSTOM_AGENT_TOOL_NAMES = 256;
export const MAX_CUSTOM_AGENT_TOOL_NAME_CHARS = 128;

const CUSTOM_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;

/** Agent names share the start item's namespace with profiles, so they never reuse a profile ID. */
export const isCustomAgentName = (value: string): boolean =>
  CUSTOM_AGENT_NAME_PATTERN.test(value) && !isProfileId(value);

export interface CustomAgentTools {
  /** When present, the child inherits only these root tools. */
  readonly allow?: ReadonlyArray<string> | undefined;
  /** Root tools the child never inherits. */
  readonly deny?: ReadonlyArray<string> | undefined;
}

/** One `agents` entry as a configuration document declares it. */
export interface CustomAgentDefinition {
  readonly description: string;
  readonly instructions: string;
  readonly profile?: ProfileId | undefined;
  readonly effort?: SubagentEffort | undefined;
  readonly context?: SubagentContextMode | undefined;
  readonly writeIntent?: SubagentWriteIntent | undefined;
  readonly isolation?: WriterWorkspaceMode | undefined;
  readonly tools?: CustomAgentTools | undefined;
}

export const CUSTOM_AGENT_SCOPES = ["global", "project"] as const;
export type CustomAgentScope = (typeof CUSTOM_AGENT_SCOPES)[number];

/** Distinct agents the global and project layers can resolve to, each layer holding its maximum. */
export const MAX_RESOLVED_CUSTOM_AGENTS = CUSTOM_AGENT_SCOPES.length * MAX_CUSTOM_AGENTS;

/**
 * A resolved agent, frozen into each launch: its instructions replace
 * the routed profile's guidance, and its effort, context, and write intent override every
 * candidate of that profile's route.
 */
export interface CustomAgent extends Omit<CustomAgentDefinition, "profile"> {
  readonly name: string;
  readonly profile: ProfileId;
  readonly source: CustomAgentScope;
}

/** An agent that fails closed; without a name, a whole document's `agents` object is invalid. */
export interface InvalidCustomAgent {
  readonly scope: CustomAgentScope;
  readonly name?: string | undefined;
}

/** A document's decoded agents and the entries that failed to decode. */
interface DeclaredCustomAgentLayer {
  readonly scope: CustomAgentScope;
  readonly agents?: Readonly<Record<string, CustomAgentDefinition>> | undefined;
  readonly invalidNames: ReadonlyArray<string>;
  readonly containerInvalid: boolean;
}

interface ResolvedCustomAgents {
  readonly agents: ReadonlyArray<CustomAgent>;
  readonly invalidAgents: ReadonlyArray<InvalidCustomAgent>;
}

/**
 * Layers documents from lowest to highest precedence. A higher entry replaces a same-named lower
 * one wholesale, and an invalid entry fails that name closed rather than revealing the lower one.
 * An invalid `agents` object could have replaced any lower agent, so it hides them all.
 */
export const resolveCustomAgents = (
  layers: ReadonlyArray<DeclaredCustomAgentLayer>,
): ResolvedCustomAgents => {
  const agents = new Map<string, CustomAgent>();
  const invalidNames = new Map<string, InvalidCustomAgent>();
  const invalidContainers: InvalidCustomAgent[] = [];
  for (const layer of layers) {
    if (layer.containerInvalid) {
      agents.clear();
      invalidNames.clear();
      invalidContainers.push({ scope: layer.scope });
    }
    for (const [name, definition] of Rec.toEntries(layer.agents ?? {})) {
      invalidNames.delete(name);
      agents.set(name, {
        ...definition,
        name,
        profile: definition.profile ?? "generalist",
        source: layer.scope,
      });
    }
    for (const name of layer.invalidNames) {
      agents.delete(name);
      invalidNames.set(name, { scope: layer.scope, name });
    }
  }
  return {
    agents: [...agents.values()],
    invalidAgents: [...invalidContainers, ...invalidNames.values()],
  };
};

type CustomAgentLookup =
  | { readonly kind: "found"; readonly agent: CustomAgent }
  | { readonly kind: "invalid"; readonly scope: CustomAgentScope }
  | { readonly kind: "unknown" };

export const lookupCustomAgent = (
  resolved: ResolvedCustomAgents,
  name: string,
): CustomAgentLookup => {
  const agent = Option.getOrUndefined(
    Arr.findFirst(resolved.agents, (candidate) => candidate.name === name),
  );
  if (agent) return { kind: "found", agent };
  // An invalid entry, or an invalid `agents` object that may have declared it, fails it closed.
  return Fn.pipe(
    Arr.findFirst(resolved.invalidAgents, (entry) => entry.name === name),
    Option.orElse(() => Arr.findFirst(resolved.invalidAgents, (entry) => entry.name === undefined)),
    Option.match({
      onNone: () => ({ kind: "unknown" }),
      onSome: (invalid) => ({ kind: "invalid", scope: invalid.scope }),
    }),
  );
};

export const hasCustomAgentToolPolicy = (agent: Pick<CustomAgent, "tools">): boolean =>
  agent.tools?.allow !== undefined || agent.tools?.deny !== undefined;

const CUSTOM_AGENT_SKIP_CODES = {
  toolsUnsupported: "agent_tools_unsupported",
  candidateIncompatible: "agent_candidate_incompatible",
} as const;

type CustomAgentCandidate =
  | { readonly kind: "eligible"; readonly candidate: ProfileCandidate }
  | {
      readonly kind: "skipped";
      readonly code: (typeof CUSTOM_AGENT_SKIP_CODES)[keyof typeof CUSTOM_AGENT_SKIP_CODES];
      readonly reason: string;
    };

/**
 * Applies an agent's overrides to one route candidate. Tool lists filter only a Pi child's
 * inherited tools, so Claude candidates fail closed when an agent sets them.
 */
export const customAgentCandidate = (
  candidate: ProfileCandidate,
  agent: CustomAgent,
): CustomAgentCandidate => {
  if (hasCustomAgentToolPolicy(agent) && candidate.runtime !== "pi")
    return {
      kind: "skipped",
      code: CUSTOM_AGENT_SKIP_CODES.toolsUnsupported,
      reason: `Agent ${agent.name} sets tool lists, which only local Pi children can enforce; local/${candidate.runtime} is skipped.`,
    };
  const overridden: ProfileCandidate = {
    ...candidate,
    effort: agent.effort ?? candidate.effort,
    context: agent.context ?? candidate.context,
    writeIntent: agent.writeIntent ?? candidate.writeIntent,
  };
  const issues = profileCandidateValidationIssues(overridden);
  if (issues.length === 0) return { kind: "eligible", candidate: overridden };
  return {
    kind: "skipped",
    code: CUSTOM_AGENT_SKIP_CODES.candidateIncompatible,
    reason: `Agent ${agent.name}'s overrides don't fit local/${candidate.runtime} ${candidate.model}: ${Fn.pipe(
      issues,
      Arr.map((issue) => issue.code),
      Arr.join(", "),
    )}.`,
  };
};
