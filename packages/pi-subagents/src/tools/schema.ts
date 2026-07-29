import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PROFILE_IDS } from "../profiles/model.ts";
import { EXPLICIT_SUBAGENT_MODEL_SELECTOR } from "../run/model-catalog.ts";
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

const StartSpecParameters = Type.Object(
  {
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
    execution: Type.Optional(
      StringEnum(["foreground", "background"] as const, {
        description:
          "Launch behavior; defaults to background. Foreground blocks subagent_start until the run finishes, pauses, or asks a parent question. Use at most one foreground agent per start call.",
      }),
    ),
    context: Type.Optional(
      StringEnum(["fresh", "fork"] as const, {
        description:
          'Child context. Explicit values override the profile default. Only oracle defaults to "fork"; every other profile defaults to "fresh". Fork requires effective Pi routing and a persisted parent leaf.',
      }),
    ),
    profile: Type.Optional(
      StringEnum(PROFILE_IDS, {
        description:
          "Behavior and automatic routing profile. Omit to use configured defaultProfile. An explicit model overrides only the profile model route; profile guidance and defaults remain active.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          'One-run explicit model selector: copy a listed "pi/provider/model-id" or Claude alias, or pass "claude-cli/full-claude-model-id". Omit to route through project/global profile settings.',
        minLength: 1,
        maxLength: 512,
        pattern: EXPLICIT_SUBAGENT_MODEL_SELECTOR.source,
      }),
    ),
    writeIntent: Type.Optional(
      StringEnum(["writer", "read-only"] as const, {
        description:
          "Explicit capability override. Omit to use the profile default. Only one shared-cwd writer may be active.",
      }),
    ),
    effort: Type.Optional(
      StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
        description:
          "Explicit thinking-effort override. Omit to use the candidate effort, then the profile default effort, then the parent effort. claude-cli supports low through max only; off and minimal are rejected.",
      }),
    ),
  },
  strictObjectOptions,
);

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
    query: Type.Optional(
      Type.String({
        description:
          "Optional search text; every whitespace-separated term must match, so extra terms narrow the results. A blank query intentionally lists the unfiltered catalog.",
        maxLength: 512,
      }),
    ),
    backend: Type.Optional(
      StringEnum(["pi", "claude-cli"] as const, {
        description: "Optional backend filter for explicit launch-ready model selectors.",
      }),
    ),
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
      description: "One to twelve independent subagents to launch.",
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
        "Return when all selected runs are finished, or when any selected run is finished. Finished includes completed, failed, and stopped.",
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
    action: StringEnum(["interrupt", "resume", "stop"] as const, {
      description: "Lifecycle operation. The optional message is valid only for resume.",
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

export type SubagentToolInput =
  | ({ readonly action: "models" } & SubagentModelsInput)
  | ({ readonly action: "start" } & SubagentStartInput)
  | ({ readonly action: "list" } & SubagentListInput)
  | ({ readonly action: "status" } & SubagentStatusInput)
  | ({ readonly action: "await" } & SubagentAwaitInput)
  | ({ readonly action: "send" } & SubagentSendInput)
  | ({ readonly action: "reply" } & SubagentReplyInput)
  | SubagentLifecycleInput
  | ({ readonly action: "rename" } & SubagentRenameInput);

export const prepareSubagentStartArguments = (args: unknown): SubagentStartInput => {
  // Pi performs the authoritative TypeBox validation immediately after this friendly preflight.
  const prepared = args as SubagentStartInput;
  if (!args || typeof args !== "object" || Array.isArray(args)) return prepared;
  const record = args as Readonly<Record<string, unknown>>;
  const agents = record.agents;
  if (!Array.isArray(agents)) {
    if (Object.prototype.hasOwnProperty.call(record, "task"))
      throw new Error(
        '[legacy_start_shape] subagent_start now requires { agents: [{ task: "..." }] }; wrap the top-level launch fields in the agents array.',
      );
    return prepared;
  }
  agents.forEach((agent, index) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return;
    const fields = agent as Readonly<Record<string, unknown>>;
    if (Object.prototype.hasOwnProperty.call(fields, "backend"))
      throw new Error(
        `[legacy_backend_field] subagent_start agents[${index}]: backend is no longer accepted. Omit model for automatic profile routing, or pass model as "pi/provider/model-id" or "claude-cli/alias-or-full-id".`,
      );
    if (
      fields.model !== undefined &&
      (typeof fields.model !== "string" || !EXPLICIT_SUBAGENT_MODEL_SELECTOR.test(fields.model))
    )
      throw new Error(
        `[model_selector_invalid] subagent_start agents[${index}]: model must be "pi/provider/model-id" or "claude-cli/alias-or-full-id". Copy a listed selector when available; full Claude model IDs are also accepted. Omit model for automatic profile routing.`,
      );
  });
  return prepared;
};
