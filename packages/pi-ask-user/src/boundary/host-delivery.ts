import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AsyncDelivery } from "../questionnaire/async-service.ts";
import { formatAsyncSnapshot } from "../questionnaire/format.ts";

export const ASYNC_MESSAGE_TYPE = "pi-ask-user-async-answer";
export const ASYNC_RECEIPT_TYPE = "pi-ask-user-async-delivery";
const Metadata = Schema.Struct({
  generation: Schema.String.check(Schema.isMaxLength(100)),
  deliveryId: Schema.String.check(Schema.isMaxLength(120)),
});
const decode = Schema.decodeUnknownOption(Metadata);
const decodeReceipt = Schema.decodeUnknownOption(
  Schema.Struct({ version: Schema.Literal(1), ...Metadata.fields }),
);
const metadata = <Input>(value: Input) => {
  try {
    return Option.getOrUndefined(decode(value));
  } catch {
    return undefined;
  }
};

export const createQuestionnaireGeneration = (): string => randomUUID();

/** A queued message cannot establish its own provenance after branch replacement. */
export const captureHistoricalDeliveries = (ctx: ExtensionContext): ReadonlySet<string> => {
  try {
    const ids: string[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ASYNC_RECEIPT_TYPE) continue;
      const data = Option.getOrUndefined(decodeReceipt(entry.data));
      if (data) ids.push(`${data.generation}/${data.deliveryId}`);
    }
    return new Set(ids);
  } catch {
    return new Set();
  }
};

export const acceptsAsyncMessage = (
  message: { readonly role: string; readonly customType?: string; readonly details?: unknown },
  generation: string | undefined,
  historical: ReadonlySet<string>,
): boolean => {
  if (message.role !== "custom" || message.customType !== ASYNC_MESSAGE_TYPE) return true;
  const data = metadata(message.details);
  return (
    !!data &&
    (data.generation === generation || historical.has(`${data.generation}/${data.deliveryId}`))
  );
};

export const makeAsyncDelivery =
  (pi: ExtensionAPI, generation: string, isCurrent: () => boolean): AsyncDelivery =>
  (snapshot) =>
    Effect.try({
      try: () => {
        if (!isCurrent()) throw new Error("Revoked");
        // No yield between recording the originating branch and queuing its message.
        pi.appendEntry(ASYNC_RECEIPT_TYPE, {
          version: 1,
          generation,
          deliveryId: snapshot.deliveryId,
        });
        pi.sendMessage(
          {
            customType: ASYNC_MESSAGE_TYPE,
            content: formatAsyncSnapshot(snapshot),
            display: true,
            details: {
              generation,
              deliveryId: snapshot.deliveryId,
              requestId: snapshot.requestId,
              outcome: snapshot.outcome,
            },
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      },
      catch: () =>
        new AskUserHostError({
          operation: "deliver",
          message:
            "Answer delivery was not confirmed. Retrieve the retained result with ask_user_async_control.",
        }),
    });
