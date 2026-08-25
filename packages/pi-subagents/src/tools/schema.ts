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
import { MAX_PARENT_MESSAGE_CHARS, MAX_PROTOCOL_ID_CHARS, MAX_TARGET_RUNS } from "../run/limits.ts";
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
      description: "One to twelve independent subagents to launch with configured profile routing.",
      minItems: 1,
      maxItems: MAX_TARGET_RUNS,
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

export const LifecycleParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("resume", {
        description: "Resume a run that advertises the resume capability.",
      }),
      runIds: RunIdsParameters,
      message: Type.Optional(MessageParameters),
    },
    strictObjectOptions,
  ),
  Type.Object(
    {
      action: StringEnum(["interrupt", "stop"] as const, {
        description:
          "Interrupt requires the interrupt capability; stop is always available for active runs.",
      }),
      runIds: RunIdsParameters,
    },
    strictObjectOptions,
  ),
  Type.Object(
    {
      action: Type.Literal("retry", {
        description:
          "Continue failed runs on the next candidate in their immutable launch-time profile route.",
      }),
      runIds: RunIdsParameters,
    },
    strictObjectOptions,
  ),
]);

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

export const ClaimsParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("list"),
      runIds: RunIdsParameters,
    },
    strictObjectOptions,
  ),
  Type.Object(
    {
      action: StringEnum(["grant", "revoke"] as const),
      runId: RunIdParameter,
      paths: WritePathsParameters,
    },
    strictObjectOptions,
  ),
  Type.Object(
    {
      action: Type.Literal("resume_admission"),
      runId: RunIdParameter,
    },
    strictObjectOptions,
  ),
]);

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
