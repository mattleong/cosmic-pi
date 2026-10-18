import * as Option from "effect/Option";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
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
  MAX_PARENT_MESSAGE_CHARS,
  MAX_PROTOCOL_ID_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
} from "../run/limits.ts";
import { MAX_NAME_CHARS, MAX_TASK_CHARS } from "../run/state.ts";
import { SUBAGENT_TOOL_NAME, type SubagentToolName } from "../run/tool-policy.ts";
import { MAX_WORKSPACE_FILES } from "../workspace/policy.ts";
import { decodeArgumentsObject, replacementField, toolArgumentPreparer } from "./arguments.ts";

const strictObjectOptions = { additionalProperties: false } as const;
// Nonblank text is enforced by argument preparation: providers such as llama.cpp reject `pattern`.
const nonblank = (maxLength: number) => ({ minLength: 1, maxLength }) as const;
const nonblankString = (maxLength: number, description?: string) =>
  Type.String({ ...(description !== undefined && { description }), ...nonblank(maxLength) });
const RunIdParameter = Type.String(nonblank(MAX_PROTOCOL_ID_CHARS));
export const AWAIT_UNTIL = ["all_finished", "any_finished"] as const;

const PROFILE_PARAMETER_DESCRIPTION = [
  "Role and model route, chosen by the deliverable; omit for generalist.",
  ...PROFILE_IDS.map((id) => `${id}: ${PROFILE_DEFINITIONS[id].description}`),
].join(" ");

const ModelOverrideParameters = Type.Object(
  {
    runtime: StringEnum(PROFILE_CANDIDATE_RUNTIMES, { description: "Local runtime." }),
    model: nonblankString(
      MAX_PROFILE_MODEL_SELECTOR_CHARS,
      "Native model selector: provider/model or parent for pi, a Claude Code or Codex model name otherwise.",
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
      "Run this launch on exactly this model instead of the profile's route, only when the user asks for a specific model. No fallback: an unavailable model fails the launch and retry. The profile still sets role, context, and write intent.",
  },
);

// Nested children don't know the root's agents, so their schema accepts any name and the root
// checks it; the root registers the configured names as an enum instead.
const NESTED_AGENT_DESCRIPTION =
  "Optional custom agent the user configured, instead of profile; call subagent_models to list them.";
const nestedAgentParameter = () =>
  Type.Unsafe<string>({
    type: "string",
    description: NESTED_AGENT_DESCRIPTION,
    ...nonblank(MAX_CUSTOM_AGENT_NAME_CHARS),
  });

const agentParameterDescription = (agents: ReadonlyArray<CustomAgent>): string =>
  [
    "Custom agent the user configured, instead of profile; it sets its own instructions and routes through its profile.",
    ...agents.map((agent) => `${agent.name}: ${agent.description} (profile ${agent.profile})`),
  ].join(" ");

const StartSpecBaseFields = {
  task: nonblankString(
    MAX_TASK_CHARS,
    "Self-contained task: include relevant paths, constraints, evidence to inspect, and the required deliverable.",
  ),
  name: Type.Optional(nonblankString(MAX_NAME_CHARS, "Optional nonblank display name.")),
  profile: Type.Optional(StringEnum(PROFILE_IDS, { description: PROFILE_PARAMETER_DESCRIPTION })),
} as const;

const StartSpecOptionFields = {
  isolation: Type.Optional(
    StringEnum(WRITER_WORKSPACE_MODES, {
      description:
        "Writers only (profile worker, or an agent or route with writer intent): shared-checkout edits your checkout; worktree edits a private copy whose proposal you apply. Omit for the session default; a read-only run rejects it.",
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

const RunIdsParameters = Type.Array(RunIdParameter, {
  description: "Target run IDs.",
  minItems: 1,
  maxItems: MAX_TARGET_RUNS,
});

const MessageParameters = nonblankString(
  MAX_PARENT_MESSAGE_CHARS,
  "Nonblank message to send to the selected subagent or subagents.",
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
  Spec extends typeof StartSpecParameters | typeof StartSpecWithoutAgentParameters,
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
type StartToolParameters = typeof StartParameters | typeof StartWithoutAgentParameters;
const NESTED_START_PARAMETERS: StartToolParameters = StartParameters;

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
          enum: agents.map((agent) => agent.name),
          description: agentParameterDescription(agents),
        }),
      ),
      strictObjectOptions,
    ),
  );
};

const StatusParameters = Type.Object(
  {
    runIds: Type.Optional(
      Type.Array(RunIdParameter, {
        description: "Target run IDs. Omit to list every visible run as a tree, without reports.",
        minItems: 1,
        maxItems: MAX_TARGET_RUNS,
      }),
    ),
    includeDeliveredReports: Type.Optional(
      Type.Boolean({
        description:
          "With runIds, reread the latest report you already received, without another notification.",
      }),
    ),
    verbose: Type.Optional(
      Type.Boolean({
        description:
          "With runIds, add route selection, context, capabilities, process, cwd, and timing details.",
      }),
    ),
  },
  strictObjectOptions,
);

const MAX_AWAIT_TIMEOUT_SECONDS = 3_600;

const AwaitParameters = Type.Object(
  {
    runIds: RunIdsParameters,
    until: StringEnum(AWAIT_UNTIL, {
      description:
        "Return when all selected runs are finished, or when any selected run is finished. Finished includes completed, failed, and stopped.",
    }),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_AWAIT_TIMEOUT_SECONDS,
        description:
          "Stop waiting after this many seconds and return the latest observation. Subagents keep running.",
      }),
    ),
  },
  strictObjectOptions,
);

const SendParameters = Type.Object(
  {
    runIds: RunIdsParameters,
    message: MessageParameters,
  },
  strictObjectOptions,
);

const LifecycleParameters = Type.Object(
  {
    action: StringEnum(["resume", "interrupt", "stop", "retry"] as const, {
      description:
        "resume and interrupt need the run to support them; resume accepts paused, completed, failed, and stopped runs; stop works on any active run; retry continues a failed run on its next route candidate. message applies only to resume.",
    }),
    runIds: RunIdsParameters,
    message: Type.Optional(MessageParameters),
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
    preparationId: Type.Optional(RunIdParameter),
    paths: Type.Optional(
      Type.Array(nonblankString(1_023), {
        description: "apply only: changed paths to integrate now; the rest stay as the proposal.",
        minItems: 1,
        maxItems: MAX_WORKSPACE_FILES,
        uniqueItems: true,
      }),
    ),
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
        description: "list or review paging offset, from the previous page.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 16_000,
        description: "Maximum review characters per page; default 16000.",
      }),
    ),
    message: Type.Optional(MessageParameters),
  },
  strictObjectOptions,
);

export type SubagentWorkspaceInput = Static<typeof WorkspaceParameters>;

type WorkspaceField = Exclude<keyof SubagentWorkspaceInput, "action">;
const WORKSPACE_ACTION_FIELDS = {
  list: { required: [], optional: ["offset"] },
  review: { required: ["workspaceId"], optional: ["revisionId", "offset", "limit"] },
  prepare: { required: ["workspaceId", "revisionId"], optional: [] },
  apply: { required: ["workspaceId"], optional: ["revisionId", "preparationId", "paths"] },
  discard: { required: ["workspaceId"], optional: [] },
  revise: { required: ["workspaceId", "message"], optional: ["rebase"] },
} satisfies Record<
  SubagentWorkspaceInput["action"],
  {
    readonly required: ReadonlyArray<WorkspaceField>;
    readonly optional: ReadonlyArray<WorkspaceField>;
  }
>;
const WORKSPACE_FIELDS = Object.keys(WorkspaceParameters.properties).filter(
  (field): field is WorkspaceField => field !== "action",
);

export const workspaceOperationError = (operation: SubagentWorkspaceInput): string | undefined => {
  const fields = WORKSPACE_ACTION_FIELDS[operation.action];
  const missing = fields.required.find((field) => operation[field] === undefined);
  if (missing) return `Workspace ${operation.action} requires ${missing}.`;
  const allowed = new Set<WorkspaceField>([...fields.required, ...fields.optional]);
  const unexpected = WORKSPACE_FIELDS.find(
    (field) => operation[field] !== undefined && !allowed.has(field),
  );
  if (unexpected) return `Workspace ${operation.action} does not accept ${unexpected}.`;
  if (
    operation.action === "apply" &&
    operation.preparationId !== undefined &&
    operation.revisionId === undefined
  )
    return "Workspace apply with preparationId requires the exact revisionId it prepared.";
  if (
    operation.action === "apply" &&
    operation.preparationId !== undefined &&
    operation.paths !== undefined
  )
    return "Workspace apply with preparationId integrates that whole preparation and does not accept paths.";
  return undefined;
};

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentModelsInput = Static<typeof ModelsParameters>;
export type SubagentStartInput = Static<typeof StartParameters>;
export type SubagentLifecycleInput = Static<typeof LifecycleParameters>;
type SubagentStatusInput = Static<typeof StatusParameters>;

export const lifecycleMessageError = (input: SubagentLifecycleInput): string | undefined =>
  input.action !== "resume" && input.message !== undefined
    ? 'subagent_lifecycle message is valid only when action="resume".'
    : undefined;

export const statusOperationError = (input: SubagentStatusInput): string | undefined =>
  input.runIds !== undefined
    ? undefined
    : input.includeDeliveredReports !== undefined
      ? "subagent_status includeDeliveredReports requires runIds."
      : input.verbose !== undefined
        ? "subagent_status verbose requires runIds."
        : undefined;

export const SUBAGENT_TOOL_SCHEMAS = {
  [SUBAGENT_TOOL_NAME.models]: { parameters: ModelsParameters },
  [SUBAGENT_TOOL_NAME.start]: { parameters: NESTED_START_PARAMETERS },
  [SUBAGENT_TOOL_NAME.status]: { parameters: StatusParameters, validate: statusOperationError },
  [SUBAGENT_TOOL_NAME.await]: { parameters: AwaitParameters },
  [SUBAGENT_TOOL_NAME.send]: { parameters: SendParameters },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    parameters: LifecycleParameters,
    validate: lifecycleMessageError,
  },
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
    : N extends typeof SUBAGENT_TOOL_NAME.status
      ? "status" | "list"
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
  // Status without run IDs lists the visible run tree.
  [SUBAGENT_TOOL_NAME.status]: (args) => (args.runIds === undefined ? "list" : "status"),
  [SUBAGENT_TOOL_NAME.await]: () => "await",
  [SUBAGENT_TOOL_NAME.send]: () => "send",
  [SUBAGENT_TOOL_NAME.lifecycle]: (args) => args.action,
  [SUBAGENT_TOOL_NAME.workspace]: () => "workspace",
};

export const subagentToolAction = <N extends SubagentToolName>(
  input: SubagentToolInput<N>,
): ToolActions[N] => TOOL_ACTIONS[input.tool](input.args);

const START_SPEC_FIELDS = Object.keys(StartSpecFields);

const checkStartAgents = (agents: ReadonlyArray<JsonValue>): void =>
  agents.forEach((candidate, index) => {
    const agent = Option.getOrUndefined(decodeArgumentsObject(candidate));
    if (!agent) return;
    const disallowedField = firstDisallowedLaunchOverride(agent);
    if (disallowedField)
      throw new Error(
        disallowedLaunchOverrideMessage(disallowedField, `subagent_start agents[${index}]`),
      );
    if (Object.hasOwn(agent, "agent") && Object.hasOwn(agent, "profile"))
      throw new Error(
        `[agent_profile_conflict] subagent_start agents[${index}] sets both agent and profile; an agent routes through its own profile, so set only one.`,
      );
  });

const inspectStartArguments = (args: JsonObject): void => {
  const agents = args.agents;
  if (Array.isArray(agents)) return checkStartAgents(agents);
  const misplaced = Object.keys(args).filter(
    (key) =>
      START_SPEC_FIELDS.includes(key) || replacementField(key, START_SPEC_FIELDS) !== undefined,
  );
  if (misplaced.length === 0) return undefined;
  const renamed = misplaced.flatMap((key) => {
    const replacement = replacementField(key, START_SPEC_FIELDS);
    return replacement ? [`"${replacement}" for "${key}"`] : [];
  });
  throw new Error(
    `[invalid_start_shape] subagent_start requires { agents: [{ task: "..." }] }; move ${misplaced.map((key) => `"${key}"`).join(", ")} into an agents entry.${renamed.length > 0 ? ` Inside it, use ${renamed.join(", ")}.` : ""}`,
  );
};

/**
 * Pi `prepareArguments` hook for one tool: precise argument errors and nonblank text, plus the
 * launch-shape checks for subagent_start.
 */
export const subagentArgumentPreparer = <N extends SubagentToolName>(
  name: N,
  parameters: SubagentToolParameters<N> = SUBAGENT_TOOL_SCHEMAS[name].parameters,
) => {
  return toolArgumentPreparer(
    name,
    parameters,
    (value): value is SubagentToolArgs<N> => Check(parameters, value),
    name === SUBAGENT_TOOL_NAME.start ? inspectStartArguments : undefined,
  );
};
