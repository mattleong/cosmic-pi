import * as Schema from "effect/Schema";
import { WriterWorkspaceModeSchema } from "../config/schema.ts";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  CUSTOM_AGENT_SCOPES,
  MAX_CUSTOM_AGENT_DESCRIPTION_CHARS,
  MAX_CUSTOM_AGENT_TOOL_NAME_CHARS,
  MAX_CUSTOM_AGENT_TOOL_NAMES,
  MAX_RESOLVED_CUSTOM_AGENTS,
} from "../profiles/agents.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_CANDIDATE_CONTEXTS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
  PROFILE_ROUTE_SOURCES,
} from "../profiles/model.ts";
import {
  AgentNameSchema,
  InvalidAgentCardSchema,
  MAX_INVALID_AGENT_ENTRIES,
  NonEmptyText,
} from "./details-schema.ts";

export const MAX_DISCOVERY_TEXT_CHARS = 1_024;

const CandidatesSchema = Schema.Array(
  Schema.Struct({
    runtime: Schema.Literals(PROFILE_CANDIDATE_RUNTIMES),
    model: NonEmptyText(MAX_PROFILE_MODEL_SELECTOR_CHARS),
    effort: Schema.Literals(PROFILE_CANDIDATE_EFFORTS),
    context: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
    writeIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
    openaiFastMode: Schema.Boolean,
    status: Schema.Literals(["eligible", "skipped"]),
    reason: NonEmptyText(MAX_DISCOVERY_TEXT_CHARS),
  }),
).check(Schema.isMaxLength(MAX_PROFILE_CANDIDATES));

const AgentToolNamesSchema = Schema.Array(NonEmptyText(MAX_CUSTOM_AGENT_TOOL_NAME_CHARS)).check(
  Schema.isMaxLength(MAX_CUSTOM_AGENT_TOOL_NAMES),
);

export const ModelsContractFields = {
  fallbackProfile: Schema.Literals(PROFILE_IDS),
  profiles: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(PROFILE_IDS),
      description: NonEmptyText(MAX_DISCOVERY_TEXT_CHARS),
      source: Schema.Literals(PROFILE_ROUTE_SOURCES),
      isDefault: Schema.Boolean,
      defaultContext: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
      defaultWriteIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
      defaultEffort: Schema.optionalKey(Schema.Literals(SUBAGENT_EFFORTS)),
      candidates: CandidatesSchema,
    }),
  ).check(Schema.isMaxLength(PROFILE_IDS.length)),
  /** Custom agents, each with its routed profile's candidates after the agent's overrides. */
  agents: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: AgentNameSchema,
        description: NonEmptyText(MAX_CUSTOM_AGENT_DESCRIPTION_CHARS),
        profile: Schema.Literals(PROFILE_IDS),
        source: Schema.Literals(CUSTOM_AGENT_SCOPES),
        effort: Schema.optionalKey(Schema.Literals(SUBAGENT_EFFORTS)),
        context: Schema.optionalKey(Schema.Literals(PROFILE_CANDIDATE_CONTEXTS)),
        writeIntent: Schema.optionalKey(Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS)),
        isolation: Schema.optionalKey(WriterWorkspaceModeSchema),
        tools: Schema.optionalKey(
          Schema.Struct({
            allow: Schema.optionalKey(AgentToolNamesSchema),
            deny: Schema.optionalKey(AgentToolNamesSchema),
          }),
        ),
        candidates: CandidatesSchema,
      }),
    ).check(Schema.isMaxLength(MAX_RESOLVED_CUSTOM_AGENTS)),
  ),
  /** Agents that fail closed; an entry without a name stands for a whole invalid `agents` object. */
  invalidAgents: Schema.optionalKey(
    Schema.Array(InvalidAgentCardSchema).check(Schema.isMaxLength(MAX_INVALID_AGENT_ENTRIES)),
  ),
};
