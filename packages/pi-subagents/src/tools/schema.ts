import * as Option from "effect/Option";
import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { WRITER_WORKSPACE_MODES } from "../config/schema.ts";
import { PROFILE_DEFINITIONS } from "../profiles/definitions.ts";
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
import { decodeArgumentsObject, replacementField, toolArgumentPreparer } from "./arguments.ts";

const strictObjectOptions = { additionalProperties: false } as const;
// Nonblank text is enforced by argument preparation: providers such as llama.cpp reject `pattern`.
const nonblank = (maxLength: number) => ({ minLength: 1, maxLength }) as const;
const nonblankString = (maxLength: number, description?: string) =>
  Type.String({ ...(description !== undefined && { description }), ...nonblank(maxLength) });
const RunIdParameter = Type.String(nonblank(MAX_PROTOCOL_ID_CHARS));
const writePaths = (itemDescription?: string, description?: string) =>
  Type.Array(nonblankString(MAX_WRITE_CLAIM_CHARS, itemDescription), {
    ...(description !== undefined && { description }),
    minItems: 1,
    maxItems: MAX_WRITE_CLAIMS,
    uniqueItems: true,
  });

export const AWAIT_UNTIL = ["all_finished", "any_finished"] as const;

const PROFILE_PARAMETER_DESCRIPTION = [
  "Role and model route, chosen by the deliverable; omit for generalist.",
  ...PROFILE_IDS.map((id) => `${id}: ${PROFILE_DEFINITIONS[id].description}`),
].join(" ");

const StartSpecFields = {
  task: nonblankString(
    MAX_TASK_CHARS,
    "Self-contained task: include relevant paths, constraints, evidence to inspect, and the required deliverable.",
  ),
  name: Type.Optional(nonblankString(MAX_NAME_CHARS, "Optional nonblank display name.")),
  profile: Type.Optional(StringEnum(PROFILE_IDS, { description: PROFILE_PARAMETER_DESCRIPTION })),
  writes: Type.Optional(
    writePaths(
      "Exact workspace-relative POSIX file path assigned to this writer.",
      "Cooperative exact-file claims for writer profiles. Omit for exclusive whole-workspace writer ownership.",
    ),
  ),
  isolation: Type.Optional(
    StringEnum(WRITER_WORKSPACE_MODES, {
      description:
        "Where a writer works: shared-checkout edits your checkout; worktree edits a private copy you apply, or review and integrate. Omit for the session default; read-only profiles ignore it.",
    }),
  ),
} as const;

const StartSpecParameters = Type.Object(StartSpecFields, strictObjectOptions);

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
    includeDeliveredReports: Type.Optional(
      Type.Boolean({
        description: "Reread the latest report you already received, without another notification.",
      }),
    ),
  },
  strictObjectOptions,
);

export const MAX_AWAIT_TIMEOUT_SECONDS = 3_600;

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

const ReplyParameters = Type.Object(
  {
    runId: Type.String({
      ...nonblank(MAX_PROTOCOL_ID_CHARS),
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
        "resume and interrupt need the run to support them; stop works on any active run; retry continues a failed run on its next route candidate. message applies only to resume.",
    }),
    runIds: RunIdsParameters,
    message: Type.Optional(MessageParameters),
  },
  strictObjectOptions,
);

const RenameParameters = Type.Object(
  {
    runId: Type.String({ ...nonblank(MAX_PROTOCOL_ID_CHARS), description: "Run ID to rename." }),
    name: nonblankString(MAX_NAME_CHARS, "New nonblank display name."),
  },
  strictObjectOptions,
);

const ClaimsParameters = Type.Object(
  {
    action: StringEnum(["list", "grant", "revoke", "resume_admission"] as const, {
      description:
        "list takes runIds; grant and revoke take runId plus a non-empty paths array; resume_admission takes runId only.",
    }),
    runIds: Type.Optional(RunIdsParameters),
    runId: Type.Optional(RunIdParameter),
    paths: Type.Optional(writePaths()),
  },
  strictObjectOptions,
);

type ClaimsField = Exclude<keyof SubagentClaimsInput, "action">;
const CLAIMS_ACTION_FIELDS = {
  list: ["runIds"],
  grant: ["runId", "paths"],
  revoke: ["runId", "paths"],
  resume_admission: ["runId"],
} as const satisfies Record<SubagentClaimsInput["action"], ReadonlyArray<ClaimsField>>;
const CLAIMS_FIELDS = ["runIds", "runId", "paths"] as const satisfies ReadonlyArray<ClaimsField>;

export const claimsOperationError = (operation: SubagentClaimsInput): string | undefined => {
  if (!Object.hasOwn(CLAIMS_ACTION_FIELDS, operation.action))
    return "subagent_claims requires a supported action.";
  const required: ReadonlyArray<ClaimsField> = CLAIMS_ACTION_FIELDS[operation.action];
  const subject = `subagent_claims action="${operation.action}"`;
  const missing = required.find((field) =>
    field === "paths" ? !operation.paths?.length : operation[field] === undefined,
  );
  if (missing === "paths") return `${subject} requires a non-empty paths array.`;
  if (missing !== undefined) return `${subject} requires ${missing}.`;
  return CLAIMS_FIELDS.some((field) => !required.includes(field) && operation[field] !== undefined)
    ? `${subject} takes ${required.join(" and ")} only.`
    : undefined;
};

export const WorkspaceParameters = Type.Object(
  {
    action: StringEnum(
      ["list", "review", "prepare", "integrate", "apply", "discard", "revise"] as const,
      {
        description:
          "list needs no target. apply needs workspaceId: it freezes, prepares, runs the configured verification, and integrates in one call; revisionId optionally pins the revision. review freezes a cleaned-up workspace or pages an exact revision. prepare needs revisionId; integrate also needs preparationId. revise needs message and invalidates prior review/preparation. discard needs workspaceId only.",
      },
    ),
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
          "Maximum review characters per page; default 16000. The careful path reads every page before prepare and integrate.",
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
  apply: { required: ["workspaceId"], optional: ["revisionId"] },
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

export const lifecycleMessageError = (input: SubagentLifecycleInput): string | undefined =>
  input.action !== "resume" && input.message !== undefined
    ? 'subagent_lifecycle message is valid only when action="resume".'
    : undefined;

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
  [SUBAGENT_TOOL_NAME.list]: () => "list",
  [SUBAGENT_TOOL_NAME.status]: () => "status",
  [SUBAGENT_TOOL_NAME.await]: () => "await",
  [SUBAGENT_TOOL_NAME.send]: () => "send",
  [SUBAGENT_TOOL_NAME.reply]: () => "reply",
  [SUBAGENT_TOOL_NAME.lifecycle]: (args) => args.action,
  [SUBAGENT_TOOL_NAME.rename]: () => "rename",
  [SUBAGENT_TOOL_NAME.claims]: () => "claims",
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
export const subagentArgumentPreparer = <N extends SubagentToolName>(name: N) => {
  const parameters: SubagentToolParameters<N> = SUBAGENT_TOOL_SCHEMAS[name].parameters;
  return toolArgumentPreparer(
    name,
    parameters,
    (value): value is SubagentToolArgs<N> => Check(parameters, value),
    name === SUBAGENT_TOOL_NAME.start ? inspectStartArguments : undefined,
  );
};
