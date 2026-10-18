import { isJsonObject, synchronousRandomUuid } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
  MAX_SUPERVISOR_MCP_AGENT_IDS,
  MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
  MAX_SUPERVISOR_MCP_MESSAGE_CHARS,
  MAX_SUPERVISOR_MCP_REPORT_CHARS,
  SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY,
  SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
  SUPERVISOR_MCP_AGENT_TOOL_NAMES,
  SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_CONTACT_KINDS,
  SUPERVISOR_MCP_CONTACT_PARENT_TOOL_NAME,
  SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE,
  SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_REPORT_TOOL_NAME,
  SUPERVISOR_MCP_TOOL_NAMES,
  SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY,
} from "./mcp-contract.ts";
import {
  PARENT_REPLY_PREFIX,
  SupervisorAgentIdSchema,
  SupervisorAgentRefusal,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  type SupervisorDeliveryId,
  SupervisorDeliveryIdSchema,
  SupervisorMessageSchema,
  SupervisorReportTextSchema,
  SupervisorRpcFailure,
  type SupervisorRpcGroup,
} from "./protocol.ts";
import { agentListText, agentReadText, agentSendText } from "./agent-text.ts";

const CALL_TIMEOUT_MILLIS = 10_000;
// Resuming a finished run starts its process before the send settles.
const AGENT_SEND_TIMEOUT_MILLIS = 60_000;
const CONTACTS = {
  progress: { rpc: "SupervisorProgress", text: "Progress delivered to the parent projection." },
  warning: { rpc: "SupervisorWarning", text: "Warning recorded in parent-visible run status." },
} as const;

export class SupervisorToolFailure extends Schema.TaggedError<SupervisorToolFailure>()(
  "SupervisorToolFailure",
  { code: Schema.String, message: Schema.String },
) {}

export interface SupervisorToolClient {
  readonly rpc: RpcClient.FromGroup<typeof SupervisorRpcGroup, RpcClientError.RpcClientError>;
  readonly auth: Pick<SupervisorChannelConfig, "version" | "runId" | "token">;
  readonly assignmentEpoch: () => number;
  readonly closed: Deferred.Deferred<void>;
}

type SupervisorToolCall =
  | { readonly kind: (typeof SUPERVISOR_MCP_CONTACT_KINDS)[number]; readonly message: string }
  | { readonly kind: "report"; readonly deliveryId: SupervisorDeliveryId; readonly report: string }
  | { readonly kind: "agent_list"; readonly ids?: ReadonlyArray<string> | undefined }
  | { readonly kind: "agent_send"; readonly to: string; readonly message: string }
  | {
      readonly kind: "agent_read";
      readonly ids: ReadonlyArray<string>;
      readonly verbose?: boolean | undefined;
    };

interface SupervisorToolResult {
  readonly text: string;
  readonly isError: boolean;
}

type ArgumentFields<Keys extends ReadonlyArray<string>> = Record<Keys[number], Schema.Top>;
const exactArguments = { onExcessProperty: "error" } as const;
const decodeContactArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literals(SUPERVISOR_MCP_CONTACT_KINDS),
    message: SupervisorMessageSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeReportArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    delivery_id: SupervisorDeliveryIdSchema,
    report: SupervisorReportTextSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS>),
  exactArguments,
);

const decodeAgentSendArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    to: SupervisorAgentIdSchema,
    message: SupervisorMessageSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeAgentIds = Schema.decodeUnknownOption(Schema.Array(SupervisorAgentIdSchema));

interface ArgumentRule {
  readonly key: string;
  readonly maximum: number;
  readonly pattern: RegExp;
  readonly mismatch: string;
}

const nonblankRule = (key: string, maximum: number): ArgumentRule => ({
  key,
  maximum,
  pattern: new RegExp(SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE, "u"),
  mismatch: `${key} is blank; provide nonblank text.`,
});
const CONTACT_KIND_PATTERN = new RegExp(`^(?:${SUPERVISOR_MCP_CONTACT_KINDS.join("|")})$`, "u");
const CONTACT_RULES: ReadonlyArray<ArgumentRule> = [
  {
    key: SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[0],
    maximum: 16,
    pattern: CONTACT_KIND_PATTERN,
    mismatch: `${SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[0]} must be one of ${SUPERVISOR_MCP_CONTACT_KINDS.join(", ")}.`,
  },
  nonblankRule(SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[1], MAX_SUPERVISOR_MCP_MESSAGE_CHARS),
];
const AGENT_ID_PATTERN = new RegExp(SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE, "u");
const AGENT_ID_MISMATCH = "must be an agent ID from agent_list, such as main or a run ID.";
const AGENT_SEND_RULES: ReadonlyArray<ArgumentRule> = [
  {
    key: SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[0],
    maximum: MAX_SUPERVISOR_MCP_AGENT_ID_CHARS,
    pattern: AGENT_ID_PATTERN,
    mismatch: `${SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[0]} ${AGENT_ID_MISMATCH}`,
  },
  nonblankRule(SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[1], MAX_SUPERVISOR_MCP_MESSAGE_CHARS),
];
const REPORT_RULES: ReadonlyArray<ArgumentRule> = [
  {
    key: SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[0],
    maximum: MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS,
    pattern: new RegExp(SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE, "u"),
    mismatch: `${SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[0]} must start with a letter or digit and use only letters, digits, ".", "_", ":", or "-".`,
  },
  nonblankRule(SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[1], MAX_SUPERVISOR_MCP_REPORT_CHARS),
];
// Argument names are echoed only when short and plain; other caller text never is.
const ECHOABLE_KEY = /^[A-Za-z0-9_]{1,64}$/u;
const count = (value: number): string => value.toLocaleString("en-US");

// Names the first failing argument and its limit so the child can correct the call.
const argumentProblem = (
  tool: string,
  rules: ReadonlyArray<ArgumentRule>,
  args: Schema.Json | undefined,
): string | undefined => {
  const accepted = rules.map((rule) => rule.key).join(" and ");
  if (!isJsonObject(args)) return `${tool} takes an object with ${accepted}.`;
  const unexpected = Object.keys(args).find((key) => !rules.some((rule) => rule.key === key));
  if (unexpected !== undefined)
    return `Unexpected argument${ECHOABLE_KEY.test(unexpected) ? ` ${unexpected}` : ""}; ${tool} takes only ${accepted}.`;
  for (const rule of rules) {
    const value = args[rule.key];
    if (value === undefined) return `Missing ${rule.key}.`;
    if (!Predicate.isString(value)) return `${rule.key} must be a string.`;
    if (value.length > rule.maximum)
      return `${rule.key} is ${count(value.length)} characters; the limit is ${count(rule.maximum)}. Shorten it and resubmit.`;
    if (!rule.pattern.test(value)) return rule.mismatch;
  }
  return undefined;
};

const UNSUPPORTED_ARGUMENTS = "Tool input is malformed or unsupported.";

// `agentIds` is optional for agent_list and required, with at least one entry, for agent_read,
// which also accepts `verbose`.
const decodeAgentIdsCall = (
  tool: string,
  args: Schema.Json | undefined,
  required: boolean,
): Result.Result<ReadonlyArray<string> | undefined, string> => {
  const key = SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY;
  const accepted: ReadonlyArray<string> = required
    ? [key, SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY]
    : [key];
  if (!isJsonObject(args)) return Result.fail(`${tool} takes an object with ${key}.`);
  const unexpected = Object.keys(args).find((name) => !accepted.includes(name));
  if (unexpected !== undefined)
    return Result.fail(
      `Unexpected argument${ECHOABLE_KEY.test(unexpected) ? ` ${unexpected}` : ""}; ${tool} takes only ${accepted.join(" and ")}.`,
    );
  const verbose = args[SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY];
  if (verbose !== undefined && !Predicate.isBoolean(verbose))
    return Result.fail(`${SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY} must be true or false.`);
  const ids = args[key];
  if (ids === undefined)
    return required
      ? Result.fail(`Missing ${key}; name at least one agent.`)
      : Result.succeed(undefined);
  if (!Array.isArray(ids)) return Result.fail(`${key} must be an array of agent IDs.`);
  if (required && ids.length === 0) return Result.fail(`${key} is empty; name at least one agent.`);
  if (ids.length > MAX_SUPERVISOR_MCP_AGENT_IDS)
    return Result.fail(
      `${key} has ${count(ids.length)} entries; the limit is ${count(MAX_SUPERVISOR_MCP_AGENT_IDS)}.`,
    );
  if (
    !ids.every(
      (id) =>
        Predicate.isString(id) &&
        id.length <= MAX_SUPERVISOR_MCP_AGENT_ID_CHARS &&
        AGENT_ID_PATTERN.test(id),
    )
  )
    return Result.fail(`Each entry in ${key} ${AGENT_ID_MISMATCH}`);
  return Option.match(decodeAgentIds(ids), {
    onNone: () => Result.fail(UNSUPPORTED_ARGUMENTS),
    onSome: (decoded) => Result.succeed(decoded),
  });
};

const decodeAgentToolCall = (
  name: (typeof SUPERVISOR_MCP_AGENT_TOOL_NAMES)[number],
  args: Schema.Json | undefined,
): Result.Result<SupervisorToolCall, string> => {
  switch (name) {
    case "agent_list":
      return Result.map(decodeAgentIdsCall(name, args, false), (ids) => ({
        kind: "agent_list" as const,
        ...(ids !== undefined && { ids }),
      }));
    case "agent_read":
      return Result.map(decodeAgentIdsCall(name, args, true), (ids) => ({
        kind: "agent_read" as const,
        ids: ids ?? [],
        ...(isJsonObject(args) &&
          args[SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY] === true && { verbose: true }),
      }));
    case "agent_send": {
      const problem = argumentProblem(name, AGENT_SEND_RULES, args);
      if (problem !== undefined) return Result.fail(problem);
      return Option.match(decodeAgentSendArguments(args), {
        onNone: () => Result.fail(UNSUPPORTED_ARGUMENTS),
        onSome: ({ to, message }) => Result.succeed({ kind: "agent_send" as const, to, message }),
      });
    }
  }
  return absurd<Result.Result<SupervisorToolCall, string>>(name);
};

const isAgentToolName = (name: string): name is (typeof SUPERVISOR_MCP_AGENT_TOOL_NAMES)[number] =>
  SUPERVISOR_MCP_AGENT_TOOL_NAMES.some((tool) => tool === name);

/** Decodes a tool call, or explains which argument to fix. */
export const decodeSupervisorToolCall = (
  name: string,
  args: Schema.Json | undefined,
): Result.Result<SupervisorToolCall, string> => {
  if (isAgentToolName(name)) return decodeAgentToolCall(name, args);
  if (name === SUPERVISOR_MCP_REPORT_TOOL_NAME) {
    const problem = argumentProblem(name, REPORT_RULES, args);
    if (problem !== undefined) return Result.fail(problem);
    return Option.match(decodeReportArguments(args), {
      onNone: () => Result.fail(UNSUPPORTED_ARGUMENTS),
      onSome: ({ delivery_id, report }) =>
        Result.succeed({ kind: "report" as const, deliveryId: delivery_id, report }),
    });
  }
  if (name !== SUPERVISOR_MCP_CONTACT_PARENT_TOOL_NAME)
    return Result.fail(`Unknown tool; use one of ${SUPERVISOR_MCP_TOOL_NAMES.join(", ")}.`);
  const problem = argumentProblem(name, CONTACT_RULES, args);
  if (problem !== undefined) return Result.fail(problem);
  return Option.match(decodeContactArguments(args), {
    onNone: () => Result.fail(UNSUPPORTED_ARGUMENTS),
    onSome: ({ kind, message }) => Result.succeed({ kind, message }),
  });
};

const uncertain = () =>
  new SupervisorToolFailure({
    code: "delivery_outcome_uncertain",
    message: "Supervisor RPC delivery did not settle within its bound.",
  });

const ok = (text: string, isError = false): SupervisorToolResult => ({ text, isError });

interface SupervisorToolCaller {
  readonly nativeThreadId?: string | undefined;
}

// The model can act on these refusals, so they return as tool errors rather than RPC failures.
const isToolErrorRefusal = (error: unknown): error is SupervisorRpcFailure =>
  error instanceof SupervisorRpcFailure &&
  (error.code === "report_schema_invalid" || error.code === "native_sub_agent_refused");
const refusedResult = (error: SupervisorRpcFailure | SupervisorAgentRefusal) =>
  Effect.succeed(
    error instanceof SupervisorAgentRefusal
      ? ok(`Refused (${error.code}): ${error.message}`, true)
      : ok(error.message, true),
  );
const isAgentRefusal = (error: unknown): error is SupervisorRpcFailure | SupervisorAgentRefusal =>
  error instanceof SupervisorAgentRefusal || isToolErrorRefusal(error);

export const runSupervisorTool = (
  client: SupervisorToolClient,
  call: SupervisorToolCall,
  caller: SupervisorToolCaller = {},
): Effect.Effect<SupervisorToolResult, SupervisorRpcFailure | SupervisorToolFailure> =>
  Effect.gen(function* () {
    const assignmentEpoch = client.assignmentEpoch();
    if (Deferred.isDoneUnsafe(client.closed) || assignmentEpoch < 1)
      return yield* new SupervisorToolFailure({
        code: "channel_unavailable",
        message: "Private supervisor channel is unavailable or has no active assignment.",
      });
    const { rpc, auth } = client;
    const requestId = SupervisorChannelIdSchema.make(synchronousRandomUuid());
    const identity =
      caller.nativeThreadId === undefined ? {} : { nativeThreadId: caller.nativeThreadId };
    switch (call.kind) {
      case "report": {
        const { deliveryId, report: text } = call;
        return yield* rpc
          .SupervisorReport({ ...auth, assignmentEpoch, requestId, deliveryId, text, ...identity })
          .pipe(
            Effect.timeout(CALL_TIMEOUT_MILLIS),
            Effect.map((result) =>
              ok(
                `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
              ),
            ),
            Effect.catchIf(isToolErrorRefusal, (error) => Effect.succeed(ok(error.message, true))),
          );
      }
      case "question":
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(
            rpc.SupervisorQuestion({
              ...auth,
              assignmentEpoch,
              requestId,
              message: call.message,
              ...identity,
            }),
          ).pipe(
            Effect.flatMap((reply) =>
              rpc
                .SupervisorAcknowledgeQuestionReply({
                  ...auth,
                  assignmentEpoch,
                  questionId: reply.questionId,
                })
                .pipe(
                  Effect.timeout(CALL_TIMEOUT_MILLIS),
                  Effect.as(ok(`${PARENT_REPLY_PREFIX}${reply.message}`)),
                ),
            ),
          ),
        ).pipe(
          Effect.catchIf(isToolErrorRefusal, (error) => Effect.succeed(ok(error.message, true))),
        );
      case "progress":
      case "warning": {
        const contact = CONTACTS[call.kind];
        return yield* rpc[contact.rpc]({
          ...auth,
          assignmentEpoch,
          requestId,
          message: call.message,
          ...identity,
        }).pipe(
          Effect.timeout(CALL_TIMEOUT_MILLIS),
          Effect.as(ok(contact.text)),
          Effect.catchIf(isToolErrorRefusal, (error) => Effect.succeed(ok(error.message, true))),
        );
      }
      case "agent_list":
        return yield* rpc
          .SupervisorAgentList({
            ...auth,
            assignmentEpoch,
            ...(call.ids !== undefined && { ids: call.ids }),
          })
          .pipe(
            Effect.timeout(CALL_TIMEOUT_MILLIS),
            Effect.map((result) => ok(agentListText(result))),
            Effect.catchIf(isAgentRefusal, refusedResult),
          );
      case "agent_read":
        return yield* rpc
          .SupervisorAgentRead({
            ...auth,
            assignmentEpoch,
            ids: call.ids,
            ...(call.verbose === true && { verbose: true }),
          })
          .pipe(
            Effect.timeout(CALL_TIMEOUT_MILLIS),
            Effect.map((result) => ok(agentReadText(result))),
            Effect.catchIf(isAgentRefusal, refusedResult),
          );
      case "agent_send":
        return yield* rpc
          .SupervisorAgentSend({
            ...auth,
            assignmentEpoch,
            to: call.to,
            message: call.message,
            ...identity,
          })
          .pipe(
            Effect.timeout(AGENT_SEND_TIMEOUT_MILLIS),
            Effect.map((result) => ok(agentSendText(result))),
            Effect.catchIf(isAgentRefusal, refusedResult),
          );
    }
    return absurd<SupervisorToolResult>(call);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SupervisorRpcFailure || error instanceof SupervisorToolFailure
        ? error
        : uncertain(),
    ),
    Effect.catchCauseIf(
      (cause) => Deferred.isDoneUnsafe(client.closed) && Cause.hasInterruptsOnly(cause),
      () => Effect.fail(uncertain()),
    ),
  );
