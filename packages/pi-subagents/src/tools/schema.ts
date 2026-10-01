import type { JsonObject } from "pi-cosmic-core";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PROFILE_IDS } from "../profiles/model.ts";
import { MAX_WRITE_CLAIMS, MAX_WRITE_CLAIM_CHARS } from "../domain/write-claims.ts";
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

const NONBLANK_PATTERN = ".*\\S.*";
const strictObjectOptions = { additionalProperties: false } as const;
const runIdOptions = {
  minLength: 1,
  maxLength: MAX_PROTOCOL_ID_CHARS,
  pattern: NONBLANK_PATTERN,
} as const;
const RunIdParameter = Type.String(runIdOptions);

const StartSpecFields = {
  task: Type.String({
    description:
      "Self-contained task: include relevant paths, constraints, evidence to inspect, and the required deliverable.",
    minLength: 1,
    maxLength: MAX_TASK_CHARS,
    pattern: NONBLANK_PATTERN,
  }),
  name: Type.Optional(
    Type.String({
      description: "Optional nonblank display name.",
      minLength: 1,
      maxLength: MAX_NAME_CHARS,
      pattern: NONBLANK_PATTERN,
    }),
  ),
  profile: Type.Optional(
    StringEnum(PROFILE_IDS, {
      description:
        "Behavior and model-routing profile, selected by deliverable: scout locates and explains existing code; researcher investigates external sources; planner recommends implementation strategies and ordered changes; worker implements; reviewer evaluates code, plans, and simplification opportunities before or after implementation; oracle analyzes inherited decisions; generalist handles other work. Read-only or initial work is not automatically scouting. Omit to use the fixed generalist fallback. The selected profile always determines the model route.",
    }),
  ),
  writes: Type.Optional(
    Type.Array(
      Type.String({
        description: "Exact workspace-relative POSIX file path assigned to this writer.",
        minLength: 1,
        maxLength: MAX_WRITE_CLAIM_CHARS,
        pattern: NONBLANK_PATTERN,
      }),
      {
        description:
          "Cooperative exact-file claims for writer profiles. Omit for exclusive whole-workspace writer ownership.",
        minItems: 1,
        maxItems: MAX_WRITE_CLAIMS,
        uniqueItems: true,
      },
    ),
  ),
} as const;

const StartSpecParameters = Type.Object(StartSpecFields, strictObjectOptions);

const RunIdsParameters = Type.Array(RunIdParameter, {
  description: "Target run IDs.",
  minItems: 1,
  maxItems: MAX_TARGET_RUNS,
});

const MessageParameters = Type.String({
  description: "Nonblank message to send to the selected subagent or subagents.",
  minLength: 1,
  maxLength: MAX_PARENT_MESSAGE_CHARS,
  pattern: NONBLANK_PATTERN,
});

const ModelsParameters = Type.Object(
  {
    profile: Type.Optional(
      StringEnum(PROFILE_IDS, {
        description: "Optional profile filter; omit to discover every built-in profile route.",
      }),
    ),
  },
  strictObjectOptions,
);

const StartParameters = Type.Object(
  {
    agents: Type.Array(StartSpecParameters, {
      description:
        "One to thirty-two independent subagents to launch, subject to the caller's configured direct-child capacity.",
      minItems: 1,
      maxItems: MAX_START_BATCH,
    }),
  },
  strictObjectOptions,
);

const ListParameters = Type.Object({}, strictObjectOptions);

const StatusParameters = Type.Object(
  {
    runIds: RunIdsParameters,
  },
  strictObjectOptions,
);

const AwaitParameters = Type.Object(
  {
    runIds: RunIdsParameters,
    until: StringEnum(["all_finished", "any_finished"] as const, {
      description:
        "Return when all selected runs are finished, or when any selected run is finished. Finished includes completed, failed, and stopped.",
    }),
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

const ReplyParameters = Type.Object(
  {
    runId: Type.String({
      ...runIdOptions,
      description: "Run ID waiting for a parent reply.",
    }),
    message: MessageParameters,
  },
  strictObjectOptions,
);

const LifecycleParameters = Type.Object(
  {
    action: StringEnum(["resume", "interrupt", "stop", "retry"] as const, {
      description:
        "resume requires the resume capability; interrupt requires the interrupt capability; stop is always available for active runs; retry continues failed runs on the next candidate in their immutable launch-time profile route.",
    }),
    runIds: RunIdsParameters,
    message: Type.Optional(MessageParameters),
  },
  strictObjectOptions,
);

const RenameParameters = Type.Object(
  {
    runId: Type.String({
      ...runIdOptions,
      description: "Run ID to rename.",
    }),
    name: Type.String({
      description: "New nonblank display name.",
      minLength: 1,
      maxLength: MAX_NAME_CHARS,
      pattern: NONBLANK_PATTERN,
    }),
  },
  strictObjectOptions,
);

const WritePathsParameters = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_WRITE_CLAIM_CHARS, pattern: NONBLANK_PATTERN }),
  { minItems: 1, maxItems: MAX_WRITE_CLAIMS, uniqueItems: true },
);

const ClaimsParameters = Type.Object(
  {
    action: StringEnum(["list", "grant", "revoke", "resume_admission"] as const, {
      description:
        "list takes runIds; grant and revoke take runId plus a non-empty paths array; resume_admission takes runId only.",
    }),
    runIds: Type.Optional(RunIdsParameters),
    runId: Type.Optional(RunIdParameter),
    paths: Type.Optional(WritePathsParameters),
  },
  strictObjectOptions,
);

/**
 * Per-action field requirements the flattened claims schema cannot express as one object:
 * which fields each action requires and which cross-field combinations it rejects. Returns the
 * error message, or undefined when the operation is well-formed for its action.
 */
export const claimsOperationError = (operation: SubagentClaimsInput): string | undefined => {
  switch (operation.action) {
    case "list":
      if (operation.runIds === undefined) return 'subagent_claims action="list" requires runIds.';
      if (operation.runId !== undefined || operation.paths !== undefined)
        return 'subagent_claims action="list" takes runIds only.';
      return undefined;
    case "grant":
    case "revoke":
      if (operation.runId === undefined)
        return `subagent_claims action="${operation.action}" requires runId.`;
      if (operation.paths === undefined || operation.paths.length === 0)
        return `subagent_claims action="${operation.action}" requires a non-empty paths array.`;
      if (operation.runIds !== undefined)
        return `subagent_claims action="${operation.action}" takes runId and paths only.`;
      return undefined;
    case "resume_admission":
      if (operation.runId === undefined)
        return 'subagent_claims action="resume_admission" requires runId.';
      if (operation.runIds !== undefined || operation.paths !== undefined)
        return 'subagent_claims action="resume_admission" takes runId only.';
      return undefined;
  }
};

export const WorkspaceParameters = Type.Object(
  {
    action: StringEnum(["list", "review", "prepare", "integrate", "discard", "revise"] as const, {
      description:
        "list needs no target. review freezes a cleaned-up workspace or pages an exact revision. prepare needs revisionId; integrate also needs preparationId. revise needs message and invalidates prior review/preparation. discard needs workspaceId only.",
    }),
    workspaceId: Type.Optional(RunIdParameter),
    revisionId: Type.Optional(RunIdParameter),
    preparationId: Type.Optional(RunIdParameter),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Zero-based character offset for list or immutable diff paging.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 16_000,
        description:
          "Maximum review characters per page; default 16000. Read every page before integration.",
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
  integrate: { required: ["workspaceId", "revisionId", "preparationId"], optional: [] },
  discard: { required: ["workspaceId"], optional: [] },
  revise: { required: ["workspaceId", "message"], optional: [] },
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

/** Enforce action-specific requirements without provider-incompatible union tool schemas. */
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
    operation.action === "review" &&
    (operation.offset ?? 0) > 0 &&
    operation.revisionId === undefined
  )
    return "Review paging requires the exact revisionId returned by the first page.";
  return undefined;
};

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentModelsInput = Static<typeof ModelsParameters>;
export type SubagentStartInput = Static<typeof StartParameters>;
export type SubagentLifecycleInput = Static<typeof LifecycleParameters>;
export type SubagentClaimsInput = Static<typeof ClaimsParameters>;

/** Proxy decoding rejects this; the root path reports it only for interrupt, stop, and resume. */
export const lifecycleMessageError = (input: SubagentLifecycleInput): string | undefined =>
  input.action !== "resume" && input.message !== undefined
    ? 'subagent_lifecycle message is valid only when action="resume".'
    : undefined;

/** The one tool catalog: each Pi parameter schema plus any cross-field rule it cannot express. */
export const SUBAGENT_TOOL_SCHEMAS = {
  [SUBAGENT_TOOL_NAME.models]: { parameters: ModelsParameters },
  [SUBAGENT_TOOL_NAME.start]: { parameters: StartParameters },
  [SUBAGENT_TOOL_NAME.list]: { parameters: ListParameters },
  [SUBAGENT_TOOL_NAME.status]: { parameters: StatusParameters },
  [SUBAGENT_TOOL_NAME.await]: { parameters: AwaitParameters },
  [SUBAGENT_TOOL_NAME.send]: { parameters: SendParameters },
  [SUBAGENT_TOOL_NAME.reply]: { parameters: ReplyParameters },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    parameters: LifecycleParameters,
    validate: lifecycleMessageError,
  },
  [SUBAGENT_TOOL_NAME.rename]: { parameters: RenameParameters },
  [SUBAGENT_TOOL_NAME.claims]: { parameters: ClaimsParameters, validate: claimsOperationError },
  [SUBAGENT_TOOL_NAME.workspace]: {
    parameters: WorkspaceParameters,
    validate: workspaceOperationError,
  },
} as const;

export type SubagentToolParameters<N extends SubagentToolName> =
  (typeof SUBAGENT_TOOL_SCHEMAS)[N]["parameters"];
export type SubagentToolArgs<N extends SubagentToolName> = Static<SubagentToolParameters<N>>;

/** One public tool call, keyed by tool name; its args are exactly the tool's wire arguments. */
export type SubagentToolInput<N extends SubagentToolName = SubagentToolName> = {
  readonly [P in N]: { readonly tool: P; readonly args: SubagentToolArgs<P> };
}[N];

type ToolNameAction = keyof typeof SUBAGENT_TOOL_NAME;
/** Lifecycle carries its own action; every other tool's action is its SUBAGENT_TOOL_NAME key. */
type ToolAction<I extends SubagentToolInput> =
  I extends SubagentToolInput<typeof SUBAGENT_TOOL_NAME.lifecycle>
    ? I["args"]["action"]
    : {
        readonly [A in ToolNameAction]: (typeof SUBAGENT_TOOL_NAME)[A] extends I["tool"]
          ? A
          : never;
      }[ToolNameAction];
export type SubagentToolAction = ToolAction<SubagentToolInput>;

const TOOL_NAME_ACTIONS = new Map<string, string>(
  Object.entries(SUBAGENT_TOOL_NAME).map(([action, tool]) => [tool, action]),
);

/** The persisted details action for a call, and the subject of its argument errors. */
export const subagentToolAction = <I extends SubagentToolInput>(input: I): ToolAction<I> =>
  // SAFETY: ToolAction mirrors this lookup for every catalog tool.
  (input.tool === SUBAGENT_TOOL_NAME.lifecycle
    ? input.args.action
    : TOOL_NAME_ACTIONS.get(input.tool)) as ToolAction<I>;

export const prepareSubagentStartArguments = <ArgsInput>(args: ArgsInput): SubagentStartInput => {
  // Pi performs the authoritative TypeBox validation immediately after this friendly preflight.
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  const prepared = args as SubagentStartInput;
  if (!args || !hasObjectRuntimeType(args) || Array.isArray(args)) return prepared;
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  const record = args as Readonly<JsonObject>;
  const agents = record.agents;
  if (!Array.isArray(agents)) {
    if (Object.prototype.hasOwnProperty.call(record, "task"))
      throw new Error(
        '[invalid_start_shape] subagent_start requires { agents: [{ task: "..." }] }; wrap the top-level launch fields in the agents array.',
      );
    return prepared;
  }
  agents.forEach((agent, index) => {
    if (!agent || !hasObjectRuntimeType(agent) || Array.isArray(agent)) return;
    // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
    const disallowedField = firstDisallowedLaunchOverride(agent as Readonly<JsonObject>);
    if (disallowedField)
      throw new Error(
        disallowedLaunchOverrideMessage(disallowedField, `subagent_start agents[${index}]`),
      );
  });
  return prepared;
};
