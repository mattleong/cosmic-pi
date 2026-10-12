import { synchronousRandomUuid } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "./mcp-contract.ts";
import {
  PARENT_REPLY_PREFIX,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  type SupervisorDeliveryId,
  SupervisorDeliveryIdSchema,
  SupervisorMessageSchema,
  SupervisorReportTextSchema,
  SupervisorRpcFailure,
  type SupervisorRpcGroup,
} from "./protocol.ts";

const CALL_TIMEOUT_MILLIS = 10_000;
const MESSAGE_KINDS = ["progress", "warning", "question"] as const;
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

export type SupervisorToolCall =
  | { readonly kind: (typeof MESSAGE_KINDS)[number]; readonly message: string }
  | { readonly kind: "report"; readonly deliveryId: SupervisorDeliveryId; readonly report: string };

export interface SupervisorToolResult {
  readonly text: string;
  readonly isError: boolean;
}

type ArgumentFields<Keys extends ReadonlyArray<string>> = Record<Keys[number], Schema.Top>;
const exactArguments = { onExcessProperty: "error" } as const;
const decodeMessageArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    message: SupervisorMessageSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS>),
  exactArguments,
);
const decodeReportArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    delivery_id: SupervisorDeliveryIdSchema,
    report: SupervisorReportTextSchema,
  } satisfies ArgumentFields<typeof SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS>),
  exactArguments,
);

export const decodeSupervisorToolCall = (
  name: string,
  args: Schema.Json | undefined,
): SupervisorToolCall | undefined => {
  if (name === SUPERVISOR_MCP_TOOL_NAMES[3])
    return Option.getOrUndefined(
      Option.map(decodeReportArguments(args), ({ delivery_id, report }) => ({
        kind: "report" as const,
        deliveryId: delivery_id,
        report,
      })),
    );
  const kind = MESSAGE_KINDS[SUPERVISOR_MCP_MESSAGE_TOOL_NAMES.findIndex((tool) => tool === name)];
  return kind
    ? Option.getOrUndefined(
        Option.map(decodeMessageArguments(args), ({ message }) => ({ kind, message })),
      )
    : undefined;
};

const uncertain = () =>
  new SupervisorToolFailure({
    code: "delivery_outcome_uncertain",
    message: "Supervisor RPC delivery did not settle within its bound.",
  });

const ok = (text: string, isError = false): SupervisorToolResult => ({ text, isError });

export const runSupervisorTool = (
  client: SupervisorToolClient,
  call: SupervisorToolCall,
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
            Effect.catchIf(
              (error) =>
                error instanceof SupervisorRpcFailure && error.code === "report_schema_invalid",
              (error) => Effect.succeed(ok(error.message, true)),
            ),
          );
      }
      case "question":
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(
            rpc.SupervisorQuestion({ ...auth, assignmentEpoch, requestId, message: call.message }),
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
        );
      case "progress":
      case "warning": {
        const contact = CONTACTS[call.kind];
        yield* rpc[contact.rpc]({
          ...auth,
          assignmentEpoch,
          requestId,
          message: call.message,
        }).pipe(Effect.timeout(CALL_TIMEOUT_MILLIS));
        return ok(contact.text);
      }
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
