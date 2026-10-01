// Native supervisor tool dispatch over the private Effect RPC client.
import { synchronousRandomUuid } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import {
  isSupervisorMcpMessageArguments,
  isSupervisorMcpReportArguments,
  SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "./mcp-contract.ts";
import {
  PARENT_REPLY_PREFIX,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  type SupervisorDeliveryId,
  SupervisorDeliveryIdSchema,
  SupervisorRpcFailure,
  type SupervisorRpcGroup,
} from "./protocol.ts";

const CALL_TIMEOUT_MILLIS = 10_000;
const MESSAGE_KINDS = ["progress", "warning", "question"] as const;
const CONTACTS = {
  progress: { rpc: "SupervisorProgress", text: "Progress delivered to the parent projection." },
  warning: { rpc: "SupervisorWarning", text: "Warning recorded in parent-visible run status." },
} as const;

/** Local channel failure; `SupervisorRpcFailure` remains the server's own typed rejection. */
export class SupervisorToolFailure extends Schema.TaggedError<SupervisorToolFailure>()(
  "SupervisorToolFailure",
  { code: Schema.String, message: Schema.String },
) {}

/** One opened supervisor connection; `closed` completes once it can deliver nothing more. */
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

/** Strict guards run before any RPC call because payload construction throws on invalid input. */
export const decodeSupervisorToolCall = <ArgumentsInput>(
  name: string,
  args: ArgumentsInput,
): SupervisorToolCall | undefined => {
  if (name === SUPERVISOR_MCP_TOOL_NAMES[3]) {
    if (!isSupervisorMcpReportArguments(args)) return undefined;
    const deliveryId = SupervisorDeliveryIdSchema.makeOption(args.delivery_id);
    return Option.isSome(deliveryId)
      ? { kind: "report", deliveryId: deliveryId.value, report: args.report }
      : undefined;
  }
  const kind = MESSAGE_KINDS[SUPERVISOR_MCP_MESSAGE_TOOL_NAMES.findIndex((tool) => tool === name)];
  return kind && isSupervisorMcpMessageArguments(args)
    ? { kind, message: args.message }
    : undefined;
};

const uncertain = () =>
  new SupervisorToolFailure({
    code: "delivery_outcome_uncertain",
    message: "Supervisor RPC delivery did not settle within its bound.",
  });

/**
 * Calls the supervisor for one decoded tool. Server rejections pass through; transport failures,
 * the 10 s bounds, and interruption by a closed connection become an uncertain outcome. Only the
 * caller's own interruption stays an interruption, so a cancelled question reaches the server.
 */
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
    const ok = (text: string, isError = false): SupervisorToolResult => ({ text, isError });
    switch (call.kind) {
      case "report": {
        const { deliveryId, report: text } = call;
        const result = yield* rpc
          .SupervisorReport({ ...auth, assignmentEpoch, requestId, deliveryId, text })
          .pipe(Effect.timeout(CALL_TIMEOUT_MILLIS));
        return ok(
          `${result.duplicate ? "Final report retry accepted" : "Final report accepted"}; sequence ${result.sequence}.`,
        );
      }
      case "question":
        // The reply acknowledgement for this question's epoch outlives caller interruption.
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
      default: {
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
