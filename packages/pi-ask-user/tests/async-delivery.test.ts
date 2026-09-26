import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import {
  ASYNC_MESSAGE_TYPE,
  ASYNC_RECEIPT_TYPE,
  acceptsAsyncMessage,
  captureHistoricalDeliveries,
  makeAsyncDelivery,
} from "../src/boundary/host-delivery.ts";
import type { AsyncQuestionnaireSnapshot } from "../src/questionnaire/async-model.ts";
import { opaqueFixture as opaque } from "pi-cosmic-core/testing";

const message = (generation: string, deliveryId: string) => ({
  role: "custom",
  customType: ASYNC_MESSAGE_TYPE,
  details: { generation, deliveryId },
});
const snapshot: AsyncQuestionnaireSnapshot = {
  requestId: "r",
  deliveryId: "r-answer",
  independentWork: "Inspect",
  blockedWork: "Implement",
  status: "submitted",
  delivery: "sending",
  outcome: {
    outcome: "submitted",
    answers: [{ key: "k", kind: "custom", text: "safe\u001b[31m", note: "note\u001b[31m" }],
  },
};

it("retains historical answers on the active branch while rejecting late old queued messages", () => {
  const ctx: ExtensionContext = opaque({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: ASYNC_RECEIPT_TYPE,
          data: { version: 1, generation: "old", deliveryId: "valid" },
        },
        {
          type: "custom_message",
          customType: "other",
          details: { generation: "old", deliveryId: "foreign" },
        },
      ],
    },
  });
  const historical = captureHistoricalDeliveries(ctx);
  expect(acceptsAsyncMessage(message("old", "valid"), "new", historical)).toBe(true);
  expect(acceptsAsyncMessage(message("different", "valid"), "new", historical)).toBe(false);
  expect(acceptsAsyncMessage(message("old", "queued-late"), "new", historical)).toBe(false);
  expect(acceptsAsyncMessage(message("new", "current"), "new", historical)).toBe(true);
  expect(acceptsAsyncMessage({ role: "custom", customType: "other" }, "new", historical)).toBe(
    true,
  );
  expect(acceptsAsyncMessage({ role: "assistant" }, "new", historical)).toBe(true);
});

it("malformed metadata and unavailable historical branch reads fail closed", () => {
  const ctx: ExtensionContext = opaque({
    sessionManager: {
      getBranch: () => {
        throw new Error("unavailable");
      },
    },
  });
  const historical = captureHistoricalDeliveries(ctx);
  expect(acceptsAsyncMessage(message("old", "valid"), undefined, historical)).toBe(false);
  expect(
    acceptsAsyncMessage(
      { role: "custom", customType: ASYNC_MESSAGE_TYPE, details: { generation: "new" } },
      "new",
      historical,
    ),
  ).toBe(false);
  expect(
    acceptsAsyncMessage(
      {
        role: "custom",
        customType: ASYNC_MESSAGE_TYPE,
        details: {
          get generation() {
            throw new Error("hostile");
          },
        },
      },
      "new",
      historical,
    ),
  ).toBe(false);
});

effectIt.effect(
  "the host message uses stable correlation, strips controls, and is revoked before publication",
  () =>
    Effect.gen(function* () {
      const sendMessage = vi.fn();
      const pi: ExtensionAPI = opaque({ sendMessage, appendEntry: vi.fn() });
      let active = true;
      const send = makeAsyncDelivery(pi, "generation", () => active);
      yield* send(snapshot);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
        customType: ASYNC_MESSAGE_TYPE,
        details: {
          generation: "generation",
          deliveryId: snapshot.deliveryId,
          requestId: snapshot.requestId,
        },
      });
      expect(sendMessage.mock.calls[0]?.[0].content).not.toContain("\u001b");
      expect(sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
      active = false;
      expect(yield* Effect.flip(send(snapshot))).toMatchObject({
        _tag: "AskUserHostError",
        operation: "deliver",
      });
      expect(sendMessage).toHaveBeenCalledOnce();
    }),
);

effectIt.effect(
  "a failed provenance append cannot queue a message without its branch receipt",
  () =>
    Effect.gen(function* () {
      const sendMessage = vi.fn();
      const pi: ExtensionAPI = opaque({
        sendMessage,
        appendEntry: () => {
          throw new Error("unavailable");
        },
      });
      expect(
        yield* Effect.flip(makeAsyncDelivery(pi, "generation", () => true)(snapshot)),
      ).toMatchObject({ operation: "deliver" });
      expect(sendMessage).not.toHaveBeenCalled();
    }),
);

effectIt.effect("a throwing sender produces a redacted typed failure", () =>
  Effect.gen(function* () {
    const pi: ExtensionAPI = opaque({
      appendEntry: vi.fn(),
      sendMessage: () => {
        throw new Error("secret-raw-error");
      },
    });
    const error = yield* Effect.flip(makeAsyncDelivery(pi, "generation", () => true)(snapshot));
    expect(error).toMatchObject({ _tag: "AskUserHostError", operation: "deliver" });
    expect(`${error.message} ${error.operation}`).not.toContain("secret-raw-error");
  }),
);
