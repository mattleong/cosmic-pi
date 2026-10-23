import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { synchronousRandomUuid, decodeUnknownOrUndefined } from "pi-cosmic-core";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AsyncDelivery } from "../questionnaire/async-service.ts";
import { formatAsyncSnapshot } from "../questionnaire/format.ts";

export const ASYNC_MESSAGE_TYPE = "pi-ask-user-async-answer";
export const ASYNC_RECEIPT_TYPE = "pi-ask-user-async-delivery";
const Metadata = Schema.Struct({
  generation: Schema.String.check(Schema.isMaxLength(100)),
  deliveryId: Schema.String.check(Schema.isMaxLength(120)),
});
const Receipt = Schema.Struct({ version: Schema.Literal(1), ...Metadata.fields });
const decodeReceipt = decodeUnknownOrUndefined(Receipt);
const decodeMetadata = decodeUnknownOrUndefined(Metadata);

export const createQuestionnaireGeneration = (): string => synchronousRandomUuid();

export const captureHistoricalDeliveries = (ctx: ExtensionContext): ReadonlySet<string> => {
  try {
    const ids = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ASYNC_RECEIPT_TYPE) continue;
      const data = decodeReceipt(entry.data);
      if (data) ids.add(`${data.generation}/${data.deliveryId}`);
    }
    return ids;
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
  const data = decodeMetadata(message.details);
  return (
    data !== undefined &&
    (data.generation === generation || historical.has(`${data.generation}/${data.deliveryId}`))
  );
};

const unconfirmedDelivery = () =>
  AskUserHostError.make({
    operation: "deliver",
    message:
      "Answer delivery was not confirmed. Retrieve the retained result with ask_user_async_control.",
  });

export const hostAsyncDelivery =
  (pi: ExtensionAPI, generation: string, isCurrent: () => boolean): AsyncDelivery =>
  (snapshot) =>
    // Authority is checked in the same synchronous callback as delivery; a scheduling boundary
    // between them would let a retired session deliver into its replacement.
    Effect.try({
      try: () => {
        if (!isCurrent()) return false;
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
        return true;
      },
      catch: unconfirmedDelivery,
    }).pipe(
      Effect.flatMap((delivered) => (delivered ? Effect.void : Effect.fail(unconfirmedDelivery()))),
    );
