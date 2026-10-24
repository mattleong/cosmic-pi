import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import {
  replacementField,
  toolArgumentPreparer,
  type ToolFieldAliases,
} from "pi-cosmic-core/tool-arguments";
import { Type, type Static } from "typebox";
import { WRITER_WORKSPACE_MODES } from "../config/schema.ts";
import { MAX_CUSTOM_AGENT_NAME_CHARS, type CustomAgent } from "../profiles/agents.ts";
import { PROFILE_DEFINITIONS } from "../profiles/definitions.ts";
import {
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_IDS,
} from "../profiles/model.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import {
  MAX_LIFECYCLE_TARGET_RUNS,
  MAX_PARENT_MESSAGE_CHARS,
  MAX_PROTOCOL_ID_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
} from "../run/limits.ts";
import { MAX_NAME_CHARS, MAX_TASK_CHARS } from "../run/state.ts";
import {
  MAIN_AGENT_ID,
  MAX_AGENT_TARGETS,
  MAX_RESUME_MESSAGE_CHARS,
} from "../run/agent-messaging.ts";
import {
  AGENT_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  type AgentToolName,
  type SubagentToolName,
} from "../run/tool-policy.ts";

// Parents trained on other harnesses send these field names; name the replacement instead of
// only rejecting the key.
export const SUBAGENT_FIELD_ALIASES: ToolFieldAliases = {
  prompt: "task",
  description: "name",
  subagent_type: "profile",
  subagentType: "profile",
  agent: "profile",
  agent_type: "profile",
  workspace: "isolation",
  worktree: "isolation",
  workspaceMode: "isolation",
  writerWorkspaceMode: "isolation",
};
const decodeArgumentsObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson),
);

const strictObjectOptions = { additionalProperties: false } as const;
// Nonblank text is enforced by argument preparation: providers such as llama.cpp reject `pattern`.
const nonblank = (maxLength: number) => ({ minLength: 1, maxLength }) as const;
const nonblankString = (maxLength: number, description?: string) =>
  Type.String({ ...(description !== undefined && { description }), ...nonblank(maxLength) });
const RunIdParameter = Type.String(nonblank(MAX_PROTOCOL_ID_CHARS));
export const AWAIT_UNTIL = ["all_finished", "any_finished"] as const;
type AwaitUntil = (typeof AWAIT_UNTIL)[number];

const PROFILE_PARAMETER_DESCRIPTION = Arr.join(
  [
    "Role and model route, chosen by the deliverable; omit for generalist.",
    ...Arr.map(PROFILE_IDS, (id) => `${id}: ${PROFILE_DEFINITIONS[id].description}`),
  ],
  " ",
);

const ModelOverrideParameters = Type.Object(
  {
    runtime: StringEnum(PROFILE_CANDIDATE_RUNTIMES, { description: "Local runtime." }),
    model: nonblankString(
      MAX_PROFILE_MODEL_SELECTOR_CHARS,
      "Native model selector: provider/model or parent for pi, a Claude Code model name for claude.",
    ),
    effort: Type.Optional(
      StringEnum(PROFILE_CANDIDATE_EFFORTS, {
        description: "Reasoning effort; omit for the profile default.",
      }),
    ),
  },
  {
    ...strictObjectOptions,
    description:
      "Run this launch on exactly this model instead of the profile's route, only when the user asks for a specific model or a failed run names its next candidate. No fallback: an unavailable model fails the launch. The profile still sets role, context, and write intent.",
  },
);

// Nested children don't know the root's agents, so their schema accepts any name and the root
// checks it; the root registers the configured names as an enum instead.
const NESTED_AGENT_DESCRIPTION =
  "Optional custom agent the user configured, instead of profile; call agent_profiles to list them.";
const nestedAgentParameter = () =>
  Type.Unsafe<string>({
    type: "string",
    description: NESTED_AGENT_DESCRIPTION,
    ...nonblank(MAX_CUSTOM_AGENT_NAME_CHARS),
  });

const agentParameterDescription = (agents: ReadonlyArray<CustomAgent>): string =>
  Arr.join(
    [
      "Custom agent the user configured, instead of profile; it sets its own instructions and routes through its profile.",
      ...Arr.map(
        agents,
        (agent) => `${agent.name}: ${agent.description} (profile ${agent.profile})`,
      ),
    ],
    " ",
  );

const StartSpecBaseFields = {
  task: nonblankString(
    MAX_TASK_CHARS,
    "Self-contained task: include relevant paths, constraints, evidence to inspect, and the required deliverable.",
  ),
  // Display-only, so a long name is cut to its bound rather than rejected.
  name: Type.Optional(
    nonblankString(
      MAX_TASK_CHARS,
      `Optional display name; one longer than ${MAX_NAME_CHARS} characters is cut.`,
    ),
  ),
  profile: Type.Optional(StringEnum(PROFILE_IDS, { description: PROFILE_PARAMETER_DESCRIPTION })),
} as const;

const StartSpecOptionFields = {
  isolation: Type.Optional(
    StringEnum(WRITER_WORKSPACE_MODES, {
      description:
        "Writers only (profile worker, or an agent or route with writer intent): shared-checkout edits your checkout; worktree edits a private copy whose proposal you apply. Omit to use the session's workspace setting; set it only when the user asks for one. A read-only run refuses worktree and ignores shared-checkout with a warning.",
    }),
  ),
  model: Type.Optional(ModelOverrideParameters),
} as const;

const startSpecFields = (agent: ReturnType<typeof nestedAgentParameter>) => ({
  ...StartSpecBaseFields,
  agent: Type.Optional(agent),
  ...StartSpecOptionFields,
});

const StartSpecFields = startSpecFields(nestedAgentParameter());
const StartSpecParameters = Type.Object(StartSpecFields, strictObjectOptions);
const StartSpecWithoutAgentParameters = Type.Object(
  { ...StartSpecBaseFields, ...StartSpecOptionFields },
  strictObjectOptions,
);
// A model override is for a model the user asks for, and only the root talks to the user. Only
// the root starts worktree writers, so a nested writer always shares its parent's directory.
const NestedStartSpecParameters = Type.Object(
  { ...StartSpecBaseFields, agent: Type.Optional(nestedAgentParameter()) },
  strictObjectOptions,
);

const runIdsParameters = (maxItems: number) =>
  Type.Array(RunIdParameter, { description: "Target run IDs.", minItems: 1, maxItems });

const MessageParameters = nonblankString(
  MAX_PARENT_MESSAGE_CHARS,
  "Nonblank feedback for the writer's next pass.",
);

const ModelsParameters = Type.Object(
  {
    profile: Type.Optional(
      StringEnum(PROFILE_IDS, {
        description: "Optional profile to show; omit for every profile.",
      }),
    ),
  },
  strictObjectOptions,
);

const startParameters = <
  Spec extends
    | typeof StartSpecParameters
    | typeof StartSpecWithoutAgentParameters
    | typeof NestedStartSpecParameters,
>(
  spec: Spec,
) =>
  Type.Object(
    {
      agents: Type.Array(spec, {
        description: "Independent subagents to launch, up to your direct-child limit.",
        minItems: 1,
        maxItems: MAX_START_BATCH,
      }),
    },
    strictObjectOptions,
  );

const StartParameters = startParameters(StartSpecParameters);
const StartWithoutAgentParameters = startParameters(StartSpecWithoutAgentParameters);
const NESTED_START_PARAMETERS = startParameters(NestedStartSpecParameters);
type StartToolParameters =
  | typeof StartParameters
  | typeof StartWithoutAgentParameters
  | typeof NESTED_START_PARAMETERS;

/**
 * The root's start schema: configured agents become an enum with their descriptions, and the
 * field is absent when there are none. `undefined` keeps the nested schema, which accepts any name.
 */
export const startToolParameters = (
  agents: ReadonlyArray<CustomAgent> | undefined,
): StartToolParameters => {
  if (agents === undefined) return NESTED_START_PARAMETERS;
  if (agents.length === 0) return StartWithoutAgentParameters;
  return startParameters(
    Type.Object(
      startSpecFields(
        Type.Unsafe<string>({
          type: "string",
          enum: Arr.map(agents, (agent) => agent.name),
          description: agentParameterDescription(agents),
        }),
      ),
      strictObjectOptions,
    ),
  );
};

export const MAX_AWAIT_TIMEOUT_SECONDS = 3_600;
export const DEFAULT_AWAIT_UNTIL: AwaitUntil = "all_finished";

const AwaitParameters = Type.Object(
  {
    runIds: runIdsParameters(MAX_TARGET_RUNS),
    until: Type.Optional(
      StringEnum(AWAIT_UNTIL, {
        description:
          "Return when all selected runs are finished (the default), or when any selected run is finished. Finished includes completed, failed, and stopped.",
      }),
    ),
    // Out-of-range waits are clamped by the tool rather than rejected before it runs.
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: `Stop waiting after this many whole seconds, from 1 to ${MAX_AWAIT_TIMEOUT_SECONDS.toLocaleString("en-US")} (other values are clamped), and return the latest observation. Subagents keep running.`,
      }),
    ),
  },
  strictObjectOptions,
);

type AwaitArgs = Static<typeof AwaitParameters>;

export const awaitUntil = (args: Pick<AwaitArgs, "until">): AwaitUntil =>
  args.until ?? DEFAULT_AWAIT_UNTIL;

/** The wait's bound in whole seconds, clamped to 1 through `MAX_AWAIT_TIMEOUT_SECONDS`. */
export const awaitTimeoutSeconds = (args: Pick<AwaitArgs, "timeoutSeconds">): number | undefined =>
  args.timeoutSeconds === undefined || !Number.isFinite(args.timeoutSeconds)
    ? undefined
    : Math.min(MAX_AWAIT_TIMEOUT_SECONDS, Math.max(1, Math.floor(args.timeoutSeconds)));

export const LIFECYCLE_ACTIONS = ["interrupt", "stop"] as const;

const LifecycleParameters = Type.Object(
  {
    action: StringEnum(LIFECYCLE_ACTIONS, {
      description:
        "interrupt pauses a running run whose backend supports it; stop works on any active run.",
    }),
    runIds: runIdsParameters(MAX_LIFECYCLE_TARGET_RUNS),
  },
  strictObjectOptions,
);

export const WorkspaceParameters = Type.Object(
  {
    action: StringEnum(["list", "review", "prepare", "apply", "discard", "revise"] as const, {
      description:
        "Every action but list needs workspaceId. prepare needs revisionId; revise needs message.",
    }),
    workspaceId: Type.Optional(RunIdParameter),
    revisionId: Type.Optional(RunIdParameter),
    rebase: Type.Optional(
      Type.Boolean({
        description:
          "revise only: rebuild the writer's tree from your current files first; the writer resolves any conflicts.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "review paging offset, from the previous page.",
      }),
    ),
    message: Type.Optional(MessageParameters),
  },
  strictObjectOptions,
);

export type SubagentWorkspaceInput = Static<typeof WorkspaceParameters>;

type WorkspaceField = Exclude<keyof SubagentWorkspaceInput, "action">;
// list shows every workspace, so a workspaceId it was given is listed with the rest.
const WORKSPACE_ACTION_FIELDS = {
  list: { required: [], optional: ["workspaceId"] },
  review: { required: ["workspaceId"], optional: ["revisionId", "offset"] },
  prepare: { required: ["workspaceId", "revisionId"], optional: [] },
  apply: { required: ["workspaceId"], optional: ["revisionId"] },
  discard: { required: ["workspaceId"], optional: [] },
  revise: { required: ["workspaceId", "message"], optional: ["rebase"] },
} satisfies Record<
  SubagentWorkspaceInput["action"],
  {
    readonly required: ReadonlyArray<WorkspaceField>;
    readonly optional: ReadonlyArray<WorkspaceField>;
  }
>;
const WORKSPACE_FIELDS = Arr.filter(
  Rec.keys(WorkspaceParameters.properties),
  (field) => field !== "action",
);

// Models fill fields an action doesn't use with blank text, false, or zero; those say nothing.
const isPlaceholder = (value: SubagentWorkspaceInput[WorkspaceField]): boolean =>
  value === undefined ||
  value === false ||
  value === 0 ||
  (Predicate.isString(value) && Str.trim(value).length === 0);

/**
 * Why a worktree call can't run: a required field is missing, or a field its action doesn't use
 * holds a real value, which suggests the call meant another action.
 */
export const workspaceOperationError = (operation: SubagentWorkspaceInput): string | undefined => {
  const fields = WORKSPACE_ACTION_FIELDS[operation.action];
  const missing = Option.getOrUndefined(
    Arr.findFirst(fields.required, (field) => isPlaceholder(operation[field])),
  );
  if (missing) return `Worktree ${operation.action} requires ${missing}.`;
  const allowed = new Set<WorkspaceField>([...fields.required, ...fields.optional]);
  const unexpected = Option.getOrUndefined(
    Arr.findFirst(
      WORKSPACE_FIELDS,
      (field) => !allowed.has(field) && !isPlaceholder(operation[field]),
    ),
  );
  if (unexpected) return `Worktree ${operation.action} does not accept ${unexpected}.`;
  return undefined;
};

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentModelsInput = Static<typeof ModelsParameters>;
export type SubagentStartInput = Static<typeof StartParameters>;
export type SubagentLifecycleInput = Static<typeof LifecycleParameters>;

export const SUBAGENT_TOOL_SCHEMAS = {
  [SUBAGENT_TOOL_NAME.models]: { parameters: ModelsParameters },
  // Nested requests decode against the nested schema; the root registers its own.
  [SUBAGENT_TOOL_NAME.start]: { parameters: startToolParameters(undefined) },
  [SUBAGENT_TOOL_NAME.await]: { parameters: AwaitParameters },
  [SUBAGENT_TOOL_NAME.lifecycle]: { parameters: LifecycleParameters },
  [SUBAGENT_TOOL_NAME.workspace]: {
    parameters: WorkspaceParameters,
    validate: workspaceOperationError,
  },
} as const;

export type SubagentToolParameters<N extends SubagentToolName> =
  (typeof SUBAGENT_TOOL_SCHEMAS)[N]["parameters"];
export type SubagentToolArgs<N extends SubagentToolName> = Static<SubagentToolParameters<N>>;

export type SubagentToolInput<N extends SubagentToolName = SubagentToolName> = {
  readonly [P in N]: { readonly tool: P; readonly args: SubagentToolArgs<P> };
}[N];

type ToolNameAction = keyof typeof SUBAGENT_TOOL_NAME;
type ToolActions = {
  readonly [N in SubagentToolName]: N extends typeof SUBAGENT_TOOL_NAME.lifecycle
    ? SubagentToolArgs<N>["action"]
    : {
        readonly [A in ToolNameAction]: (typeof SUBAGENT_TOOL_NAME)[A] extends N ? A : never;
      }[ToolNameAction];
};
export type SubagentToolAction = ToolActions[SubagentToolName];

type ToolActionResolvers = {
  readonly [N in SubagentToolName]: (args: SubagentToolArgs<N>) => ToolActions[N];
};

const TOOL_ACTIONS: ToolActionResolvers = {
  [SUBAGENT_TOOL_NAME.models]: () => "models",
  [SUBAGENT_TOOL_NAME.start]: () => "start",
  [SUBAGENT_TOOL_NAME.await]: () => "await",
  [SUBAGENT_TOOL_NAME.lifecycle]: (args) => args.action,
  [SUBAGENT_TOOL_NAME.workspace]: () => "workspace",
};

export const subagentToolAction = <N extends SubagentToolName>(
  input: SubagentToolInput<N>,
): ToolActions[N] => TOOL_ACTIONS[input.tool](input.args);

const AgentIdParameter = Type.String({
  description: `A run ID from agent_list, or "${MAIN_AGENT_ID}" for the session's main agent.`,
  ...nonblank(MAX_PROTOCOL_ID_CHARS),
});
const agentIdsParameter = (description: string) =>
  Type.Array(AgentIdParameter, { description, minItems: 1, maxItems: MAX_AGENT_TARGETS });

const AgentListParameters = Type.Object(
  {
    agentIds: Type.Optional(
      agentIdsParameter("Agents to show. Omit to list every agent in this session."),
    ),
  },
  strictObjectOptions,
);

const AgentSendParameters = Type.Object(
  {
    to: AgentIdParameter,
    // Only a resume takes this bound; the service bounds guidance and answers by
    // MAX_AGENT_MESSAGE_CHARS once it knows how the message reaches its target.
    message: nonblankString(
      MAX_RESUME_MESSAGE_CHARS,
      "Self-contained message; the recipient sees who sent it.",
    ),
  },
  strictObjectOptions,
);

const AgentReadParameters = Type.Object(
  {
    agentIds: agentIdsParameter("Agents to read."),
    verbose: Type.Optional(
      Type.Boolean({
        description:
          "Add route selection, context, capabilities, process, cwd, and timing details to each run's status card.",
      }),
    ),
  },
  strictObjectOptions,
);

export const AGENT_TOOL_SCHEMAS = {
  [AGENT_TOOL_NAME.list]: AgentListParameters,
  [AGENT_TOOL_NAME.send]: AgentSendParameters,
  [AGENT_TOOL_NAME.read]: AgentReadParameters,
} as const;

export type AgentToolParameters<N extends AgentToolName> = (typeof AGENT_TOOL_SCHEMAS)[N];
export type AgentToolArgs<N extends AgentToolName> = Static<AgentToolParameters<N>>;
export type AgentToolInput<N extends AgentToolName = AgentToolName> = {
  readonly [P in N]: { readonly tool: P; readonly args: AgentToolArgs<P> };
}[N];

/** Pi `prepareArguments` hook for one agent tool: precise argument errors and nonblank text. */
export const agentArgumentPreparer = <N extends AgentToolName>(name: N) => {
  const parameters: AgentToolParameters<N> = AGENT_TOOL_SCHEMAS[name];
  return toolArgumentPreparer(name, parameters, { aliases: SUBAGENT_FIELD_ALIASES });
};

const START_SPEC_FIELDS: ReadonlyArray<string> = Rec.keys(StartSpecFields);

const checkStartAgents = (agents: ReadonlyArray<JsonValue>): void =>
  Arr.forEach(agents, (candidate, index) => {
    const agent = Option.getOrUndefined(decodeArgumentsObject(candidate));
    if (!agent) return;
    const disallowedField = firstDisallowedLaunchOverride(agent);
    if (disallowedField)
      throw new Error(
        disallowedLaunchOverrideMessage(disallowedField, `agent_start agents[${index}]`),
      );
    // Null and blank optional selectors are dropped before inspection, so only set ones conflict.
    if (Predicate.isNotNullish(agent.agent) && Predicate.isNotNullish(agent.profile))
      throw new Error(
        `[agent_profile_conflict] agent_start agents[${index}] sets both agent and profile; an agent routes through its own profile, so set only one.`,
      );
  });

const inspectStartArguments = (args: JsonObject): void => {
  const agents = args.agents;
  if (Arr.isArray(agents)) return checkStartAgents(agents);
  const misplaced = Arr.filter(
    Rec.keys<string, unknown>(args),
    (key) =>
      START_SPEC_FIELDS.includes(key) ||
      replacementField(key, START_SPEC_FIELDS, SUBAGENT_FIELD_ALIASES) !== undefined,
  );
  if (misplaced.length === 0) return undefined;
  const renamed = Arr.flatMap(misplaced, (key) => {
    const replacement = replacementField(key, START_SPEC_FIELDS, SUBAGENT_FIELD_ALIASES);
    return replacement ? [`"${replacement}" for "${key}"`] : [];
  });
  throw new Error(
    `[invalid_start_shape] agent_start requires { agents: [{ task: "..." }] }; move ${Fn.pipe(
      misplaced,
      Arr.map((key) => `"${key}"`),
      Arr.join(", "),
    )} into an agents entry.${renamed.length > 0 ? ` Inside it, use ${Arr.join(renamed, ", ")}.` : ""}`,
  );
};

/**
 * Pi `prepareArguments` hook for one tool: precise argument errors and nonblank text, plus the
 * launch-shape checks for agent_start.
 */
export const subagentArgumentPreparer = <N extends SubagentToolName>(
  name: N,
  parameters: SubagentToolParameters<N> = SUBAGENT_TOOL_SCHEMAS[name].parameters,
) => {
  return toolArgumentPreparer(name, parameters, {
    aliases: SUBAGENT_FIELD_ALIASES,
    ...(name === SUBAGENT_TOOL_NAME.start && { inspect: inspectStartArguments }),
  });
};
