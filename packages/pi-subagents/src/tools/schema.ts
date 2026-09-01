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
        "Behavior and model-routing profile. Omit to use the fixed generalist fallback. The selected profile always determines the model route.",
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

export const ModelsParameters = Type.Object(
  {
    profile: Type.Optional(
      StringEnum(PROFILE_IDS, {
        description: "Optional profile filter; omit to discover every built-in profile route.",
      }),
    ),
  },
  strictObjectOptions,
);

export const StartParameters = Type.Object(
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

export const ListParameters = Type.Object({}, strictObjectOptions);

export const StatusParameters = Type.Object(
  {
    runIds: RunIdsParameters,
  },
  strictObjectOptions,
);

export const AwaitParameters = Type.Object(
  {
    runIds: RunIdsParameters,
    until: StringEnum(["all_finished", "any_finished"] as const, {
      description:
        "Return when all selected runs are finished, or when any selected run is finished. Finished includes reported retained assignments, completed, failed, and stopped.",
    }),
  },
  strictObjectOptions,
);

export const SendParameters = Type.Object(
  {
    runIds: RunIdsParameters,
    message: MessageParameters,
  },
  strictObjectOptions,
);

export const ReplyParameters = Type.Object(
  {
    runId: Type.String({
      ...runIdOptions,
      description: "Run ID waiting for a parent reply.",
    }),
    message: MessageParameters,
  },
  strictObjectOptions,
);

export const LifecycleParameters = Type.Object(
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

export const RenameParameters = Type.Object(
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

export const ClaimsParameters = Type.Object(
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

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentModelsInput = Static<typeof ModelsParameters>;
export type SubagentStartInput = Static<typeof StartParameters>;
export type SubagentListInput = Static<typeof ListParameters>;
export type SubagentStatusInput = Static<typeof StatusParameters>;
export type SubagentAwaitInput = Static<typeof AwaitParameters>;
export type SubagentSendInput = Static<typeof SendParameters>;
export type SubagentReplyInput = Static<typeof ReplyParameters>;
export type SubagentLifecycleInput = Static<typeof LifecycleParameters>;
export type SubagentRenameInput = Static<typeof RenameParameters>;
export type SubagentClaimsInput = Static<typeof ClaimsParameters>;

export type SubagentToolInput =
  | ({ readonly action: "models" } & SubagentModelsInput)
  | ({ readonly action: "start" } & SubagentStartInput)
  | ({ readonly action: "list" } & SubagentListInput)
  | ({ readonly action: "status" } & SubagentStatusInput)
  | ({ readonly action: "await" } & SubagentAwaitInput)
  | ({ readonly action: "send" } & SubagentSendInput)
  | ({ readonly action: "reply" } & SubagentReplyInput)
  | SubagentLifecycleInput
  | ({ readonly action: "rename" } & SubagentRenameInput)
  | { readonly action: "claims"; readonly operation: SubagentClaimsInput };

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
