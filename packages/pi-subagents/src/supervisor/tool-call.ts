import { isJsonObject } from "pi-cosmic-core/platform/json-document";
import { synchronousRandomUuid } from "pi-cosmic-core/platform/native-crypto";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY,
  SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS,
  SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_CONTACT_KINDS,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_REPORT_TOOL_NAME,
  SUPERVISOR_MCP_TOOL_NAMES,
  SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY,
} from "./mcp-contract.ts";
import {
  AGENT_TOOL_NAME,
  CONTACT_PARENT_TOOL_NAME,
  isAgentToolName,
  type AgentToolName,
} from "../run/tool-policy.ts";
import {
  PARENT_REPLY_PREFIX,
  SupervisorAgentIdSchema,
  SupervisorAgentIdsSchema,
  type SupervisorAgentRefusal,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  type SupervisorDeliveryId,
  SupervisorDeliveryIdSchema,
  SupervisorAgentMessageSchema,
  SupervisorContactMessageSchema,
  SupervisorReportTextSchema,
  type SupervisorRpcFailure,
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

export class SupervisorToolFailure extends Schema.TaggedError<
  SupervisorToolFailure,
  { readonly brand: unique symbol }
>()("SupervisorToolFailure", { code: Schema.String, message: Schema.String }) {}

export interface SupervisorToolClient {
  readonly rpc: RpcClient.FromGroup<typeof SupervisorRpcGroup, RpcClientError.RpcClientError>;
  readonly auth: Pick<SupervisorChannelConfig, "version" | "runId" | "token">;
  readonly assignmentEpoch: () => number;
  readonly closed: Deferred.Deferred<void>;
}

type SupervisorToolCall =
  | { readonly kind: "question"; readonly message: string }
  | {
      readonly kind: Exclude<(typeof SUPERVISOR_MCP_CONTACT_KINDS)[number], "question">;
      readonly message: string;
    }
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
const exactArguments = { onExcessProperty: "error", errors: "all" } as const;
const decodeContactArguments = Schema.decodeUnknownResult(
  Schema.Struct({
    kind: Schema.Literals(SUPERVISOR_MCP_CONTACT_KINDS),
    message: SupervisorContactMessageSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeReportArguments = Schema.decodeUnknownResult(
  Schema.Struct({
    delivery_id: SupervisorDeliveryIdSchema,
    report: SupervisorReportTextSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeAgentSendArguments = Schema.decodeUnknownResult(
  Schema.Struct({
    to: SupervisorAgentIdSchema,
    message: SupervisorAgentMessageSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeAgentListArguments = Schema.decodeUnknownResult(
  Schema.Struct({
    [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY]: Schema.optionalKey(SupervisorAgentIdsSchema),
  }),
  exactArguments,
);
const decodeAgentReadArguments = Schema.decodeUnknownResult(
  Schema.Struct({
    [SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY]: SupervisorAgentIdsSchema.check(Schema.isMinLength(1)),
    [SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY]: Schema.optionalKey(Schema.Boolean),
  }),
  exactArguments,
);

/** How to tell the child to fix one argument; its limits come from the schema that rejected it. */
interface ArgumentGuidance {
  readonly key: string;
  /** The value has the wrong JSON type. */
  readonly type: string;
  /** The value has the right type but the wrong content. */
  readonly mismatch: string;
  readonly missing?: string;
  /** A list entry fails its schema. */
  readonly entry?: string;
  /** A list names no entry but must name one. */
  readonly empty?: string;
}

interface ArgumentContract {
  readonly tool: string;
  /** The arguments named when the input isn't an object. */
  readonly objectWith: string;
  /** Every accepted argument, in the order problems are reported. */
  readonly arguments: ReadonlyArray<ArgumentGuidance>;
}

const textArgument = (key: string, mismatch: string): ArgumentGuidance => ({
  key,
  type: `${key} must be a string.`,
  mismatch,
});
const nonblankArgument = (key: string) =>
  textArgument(key, `${key} is blank; provide nonblank text.`);
const AGENT_ID_MISMATCH = "must be an agent ID from agent_list, such as main or a run ID.";
const agentIdsArgument = (required: boolean): ArgumentGuidance => {
  const key = SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY;
  const type = `${key} must be an array of agent IDs.`;
  return {
    key,
    type,
    mismatch: type,
    entry: `Each entry in ${key} ${AGENT_ID_MISMATCH}`,
    ...(required && {
      missing: `Missing ${key}; name at least one agent.`,
      empty: `${key} is empty; name at least one agent.`,
    }),
  };
};
const contract = (
  tool: string,
  argumentsInOrder: ReadonlyArray<ArgumentGuidance>,
  objectWith = Arr.join(
    Arr.map(argumentsInOrder, ({ key }) => key),
    " and ",
  ),
): ArgumentContract => ({ tool, objectWith, arguments: argumentsInOrder });

const CONTACT_ARGUMENTS = contract(CONTACT_PARENT_TOOL_NAME, [
  textArgument(
    SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[0],
    `${SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[0]} must be one of ${Arr.join(SUPERVISOR_MCP_CONTACT_KINDS, ", ")}.`,
  ),
  nonblankArgument(SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS[1]),
]);
const REPORT_ARGUMENTS = contract(SUPERVISOR_MCP_REPORT_TOOL_NAME, [
  textArgument(
    SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[0],
    `${SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[0]} must start with a letter or digit and use only letters, digits, ".", "_", ":", or "-".`,
  ),
  nonblankArgument(SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS[1]),
]);
const AGENT_SEND_ARGUMENTS = contract(AGENT_TOOL_NAME.send, [
  textArgument(
    SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[0],
    `${SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[0]} ${AGENT_ID_MISMATCH}`,
  ),
  nonblankArgument(SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS[1]),
]);
const AGENT_LIST_ARGUMENTS = contract(AGENT_TOOL_NAME.list, [agentIdsArgument(false)]);
const AGENT_READ_ARGUMENTS = contract(
  AGENT_TOOL_NAME.read,
  [
    agentIdsArgument(true),
    {
      key: SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY,
      type: `${SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY} must be true or false.`,
      mismatch: `${SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY} must be true or false.`,
    },
  ],
  SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY,
);

interface ArgumentIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly issue: SchemaIssue.Issue;
  readonly filter?: SchemaAST.Filter<unknown> | undefined;
}

// Each rejected value with its path and the check that rejected it.
const argumentIssues = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
  filter?: SchemaAST.Filter<unknown>,
): ReadonlyArray<ArgumentIssue> => {
  if (Predicate.isTagged(issue, "Pointer"))
    return argumentIssues(issue.issue, [...path, ...issue.path], filter);
  if (Predicate.isTagged(issue, "Composite"))
    return Arr.flatMap(issue.issues, (inner) => argumentIssues(inner, path, filter));
  if (Predicate.isTagged(issue, "Filter")) return argumentIssues(issue.issue, path, issue.filter);
  if (Predicate.isTagged(issue, "Encoding")) return argumentIssues(issue.issue, path, filter);
  return [{ path, issue, filter }];
};

const decodeMaxLengthCheck = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Literal("effect/schema/isMaxLength"),
    payload: Schema.Struct({ maxLength: Schema.Finite }),
  }),
);
const decodeMinLengthCheck = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.Literal("effect/schema/isMinLength") }),
);
const checkRepresentation = ({ filter }: ArgumentIssue) => filter?.annotations?.representation;

// Argument names are echoed only when short and plain; other caller text never is.
const ECHOABLE_KEY = /^[A-Za-z0-9_]{1,64}$/u;
const count = (value: number): string => value.toLocaleString("en-US");

const argumentProblemFor = (
  { key, type, mismatch, missing, entry, empty }: ArgumentGuidance,
  value: Schema.Json | undefined,
  issues: ReadonlyArray<ArgumentIssue>,
): string => {
  const own = Arr.filter(issues, ({ path }) => path.length === 1);
  const has = (tag: SchemaIssue.Issue["_tag"]) =>
    Arr.some(own, ({ issue }) => Predicate.isTagged(issue, tag));
  if (has("MissingKey")) return missing ?? `Missing ${key}.`;
  if (has("InvalidType")) return type;
  const maximum = Fn.pipe(
    Arr.findFirst(own, (issue) => decodeMaxLengthCheck(checkRepresentation(issue))),
    Option.map((check) => check.payload.maxLength),
    Option.getOrUndefined,
  );
  if (maximum !== undefined && Arr.isArray(value))
    return `${key} has ${count(value.length)} entries; the limit is ${count(maximum)}.`;
  if (maximum !== undefined && Predicate.isString(value))
    return `${key} is ${count(value.length)} characters; the limit is ${count(maximum)}. Shorten it and resubmit.`;
  if (
    empty !== undefined &&
    Arr.some(own, (issue) => Option.isSome(decodeMinLengthCheck(checkRepresentation(issue))))
  )
    return empty;
  if (entry !== undefined && Arr.some(issues, ({ path }) => path.length > 1)) return entry;
  return Predicate.isString(value) ? mismatch : type;
};

const UNSUPPORTED_ARGUMENTS = "Tool input is malformed or unsupported.";

// Names the first failing argument and its limit so the child can correct the call.
const argumentProblem = (
  { tool, objectWith, arguments: accepted }: ArgumentContract,
  args: Schema.Json | undefined,
  issue: SchemaIssue.Issue,
): string => {
  if (!isJsonObject(args)) return `${tool} takes an object with ${objectWith}.`;
  const issues = argumentIssues(issue);
  const unexpected = Fn.pipe(
    Arr.findFirst(issues, ({ issue: found }) => Predicate.isTagged(found, "UnexpectedKey")),
    Option.map(({ path }) => path[0]),
    Option.getOrUndefined,
  );
  if (unexpected !== undefined) {
    const name = String(unexpected);
    return `Unexpected argument${ECHOABLE_KEY.test(name) ? ` ${name}` : ""}; ${tool} takes only ${Arr.join(
      Arr.map(accepted, ({ key }) => key),
      " and ",
    )}.`;
  }
  for (const guidance of accepted) {
    const found = Arr.filter(issues, ({ path }) => path[0] === guidance.key);
    if (found.length > 0) return argumentProblemFor(guidance, args[guidance.key], found);
  }
  return UNSUPPORTED_ARGUMENTS;
};

const decodeArguments = <A>(
  argumentContract: ArgumentContract,
  decode: (args: Schema.Json | undefined) => Result.Result<A, Schema.SchemaError>,
  args: Schema.Json | undefined,
): Result.Result<A, string> =>
  Result.mapError(decode(args), (error) => argumentProblem(argumentContract, args, error.issue));

const decodeAgentToolCall = (
  name: AgentToolName,
  args: Schema.Json | undefined,
): Result.Result<SupervisorToolCall, string> => {
  switch (name) {
    case "agent_list":
      return Result.map(
        decodeArguments(AGENT_LIST_ARGUMENTS, decodeAgentListArguments, args),
        ({ agentIds }) => ({ kind: "agent_list" as const, ...(agentIds && { ids: agentIds }) }),
      );
    case "agent_read":
      return Result.map(
        decodeArguments(AGENT_READ_ARGUMENTS, decodeAgentReadArguments, args),
        ({ agentIds, verbose }) => ({
          kind: "agent_read" as const,
          ids: agentIds,
          ...(verbose === true && { verbose: true }),
        }),
      );
    case "agent_send":
      return Result.map(
        decodeArguments(AGENT_SEND_ARGUMENTS, decodeAgentSendArguments, args),
        ({ to, message }) => ({ kind: "agent_send" as const, to, message }),
      );
  }
  return Fn.absurd<Result.Result<SupervisorToolCall, string>>(name);
};

/** Decodes a tool call, or explains which argument to fix. */
export const decodeSupervisorToolCall = (
  name: string,
  args: Schema.Json | undefined,
): Result.Result<SupervisorToolCall, string> => {
  if (isAgentToolName(name)) return decodeAgentToolCall(name, args);
  if (name === SUPERVISOR_MCP_REPORT_TOOL_NAME)
    return Result.map(
      decodeArguments(REPORT_ARGUMENTS, decodeReportArguments, args),
      ({ delivery_id, report }) => ({ kind: "report" as const, deliveryId: delivery_id, report }),
    );
  if (name !== CONTACT_PARENT_TOOL_NAME)
    return Result.fail(`Unknown tool; use one of ${Arr.join(SUPERVISOR_MCP_TOOL_NAMES, ", ")}.`);
  return decodeArguments(CONTACT_ARGUMENTS, decodeContactArguments, args);
};

const uncertain = () =>
  SupervisorToolFailure.make({
    code: "delivery_outcome_uncertain",
    message: "Supervisor RPC delivery did not settle within its bound.",
  });

const ok = (text: string, isError = false): SupervisorToolResult => ({ text, isError });

// The model can act on these refusals, so they return as tool errors rather than RPC failures.
const refusalAsToolError = (error: SupervisorRpcFailure) =>
  error.code === "report_schema_invalid"
    ? Effect.succeed(ok(error.message, true))
    : Effect.fail(error);
const agentRefusalAsToolError = (error: SupervisorAgentRefusal) =>
  Effect.succeed(ok(`Refused (${error.code}): ${error.message}`, true));

type SupervisorToolError = SupervisorRpcFailure | SupervisorToolFailure;
type SupervisorToolStep<A> = Effect.Effect<A, SupervisorToolError>;

const settleTransportFailures =
  (client: SupervisorToolClient) =>
  <A>(
    step: Effect.Effect<
      A,
      SupervisorToolError | RpcClientError.RpcClientError | Cause.TimeoutError
    >,
  ): SupervisorToolStep<A> =>
    step.pipe(
      Effect.catchTags({
        RpcClientError: () => Effect.fail(uncertain()),
        TimeoutError: () => Effect.fail(uncertain()),
      }),
      Effect.catchCauseIf(
        (cause) => Deferred.isDoneUnsafe(client.closed) && Cause.hasInterruptsOnly(cause),
        () => Effect.fail(uncertain()),
      ),
    );

interface SupervisorCallContext {
  readonly rpc: SupervisorToolClient["rpc"];
  readonly auth: SupervisorToolClient["auth"];
  readonly assignmentEpoch: number;
  readonly requestId: typeof SupervisorChannelIdSchema.Type;
}

const callContext = (client: SupervisorToolClient): SupervisorToolStep<SupervisorCallContext> =>
  Effect.suspend(() => {
    const assignmentEpoch = client.assignmentEpoch();
    if (Deferred.isDoneUnsafe(client.closed) || assignmentEpoch < 1)
      return Effect.fail(
        SupervisorToolFailure.make({
          code: "channel_unavailable",
          message: "Private supervisor channel is unavailable or has no active assignment.",
        }),
      );
    return Effect.succeed({
      rpc: client.rpc,
      auth: client.auth,
      assignmentEpoch,
      requestId: SupervisorChannelIdSchema.make(synchronousRandomUuid()),
    });
  });

// The parent's reply, then the acknowledgement that consumes it and yields the result.
const questionReply = (
  { rpc, auth, assignmentEpoch, requestId }: SupervisorCallContext,
  message: string,
  settle: ReturnType<typeof settleTransportFailures>,
) =>
  rpc.SupervisorQuestion({ ...auth, assignmentEpoch, requestId, message }).pipe(
    Effect.map((reply) =>
      rpc
        .SupervisorAcknowledgeQuestionReply({
          ...auth,
          assignmentEpoch,
          questionId: reply.questionId,
        })
        .pipe(
          Effect.timeout(CALL_TIMEOUT_MILLIS),
          Effect.as(ok(`${PARENT_REPLY_PREFIX}${reply.message}`)),
          Effect.catchTag("SupervisorRpcFailure", refusalAsToolError),
          settle,
        ),
    ),
    Effect.catchTag("SupervisorRpcFailure", (error) =>
      Effect.map(refusalAsToolError(error), Effect.succeed),
    ),
  );

const answerSupervisorTool = Effect.fn("SupervisorToolCall.answerSupervisorTool")(function* (
  { rpc, auth, assignmentEpoch, requestId }: SupervisorCallContext,
  call: Exclude<SupervisorToolCall, { readonly kind: "question" }>,
) {
  switch (call.kind) {
    case "report": {
      const { deliveryId, report: text } = call;
      return yield* rpc
        .SupervisorReport({ ...auth, assignmentEpoch, requestId, deliveryId, text })
        .pipe(
          Effect.timeout(CALL_TIMEOUT_MILLIS),
          Effect.map((result) =>
            ok(
              `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
            ),
          ),
          Effect.catchTag("SupervisorRpcFailure", refusalAsToolError),
        );
    }
    case "progress":
    case "warning": {
      const contact = CONTACTS[call.kind];
      return yield* rpc[contact.rpc]({
        ...auth,
        assignmentEpoch,
        requestId,
        message: call.message,
      }).pipe(
        Effect.timeout(CALL_TIMEOUT_MILLIS),
        Effect.as(ok(contact.text)),
        Effect.catchTag("SupervisorRpcFailure", refusalAsToolError),
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
          Effect.catchTags({
            SupervisorAgentRefusal: agentRefusalAsToolError,
            SupervisorRpcFailure: refusalAsToolError,
          }),
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
          Effect.catchTags({
            SupervisorAgentRefusal: agentRefusalAsToolError,
            SupervisorRpcFailure: refusalAsToolError,
          }),
        );
    case "agent_send":
      return yield* rpc
        .SupervisorAgentSend({
          ...auth,
          assignmentEpoch,
          to: call.to,
          message: call.message,
        })
        .pipe(
          Effect.timeout(AGENT_SEND_TIMEOUT_MILLIS),
          Effect.map((result) => ok(agentSendText(result))),
          Effect.catchTags({
            SupervisorAgentRefusal: agentRefusalAsToolError,
            SupervisorRpcFailure: refusalAsToolError,
          }),
        );
  }
  return Fn.absurd<SupervisorToolResult>(call);
});

// The call's request, then the commit that turns its response into the result.
const requestSupervisorTool = (
  client: SupervisorToolClient,
  call: SupervisorToolCall,
): SupervisorToolStep<SupervisorToolStep<SupervisorToolResult>> => {
  const settle = settleTransportFailures(client);
  return callContext(client).pipe(
    Effect.flatMap((context) =>
      call.kind === "question"
        ? questionReply(context, call.message, settle)
        : Effect.map(answerSupervisorTool(context, call), Effect.succeed),
    ),
    settle,
  );
};

/**
 * Runs a tool call and passes its outcome to `deliver`. The request stays interruptible, but the
 * parent's reply is consumed once acknowledged and can't be sent again, so acknowledgement, result,
 * and delivery are one uninterruptible commit. A cancellation arriving after the reply therefore
 * waits for the bounded acknowledgement and for `deliver`, which still carries the reply.
 */
export const runSupervisorTool = <A, E, R>(
  client: SupervisorToolClient,
  call: SupervisorToolCall,
  deliver: (exit: Exit.Exit<SupervisorToolResult, SupervisorToolError>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.exit(Effect.flatten(restore(requestSupervisorTool(client, call)))).pipe(
      Effect.flatMap(deliver),
    ),
  );
