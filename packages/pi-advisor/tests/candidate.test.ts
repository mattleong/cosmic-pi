import { expect, it } from "@effect/vitest";
import { inspectAssistantMessage, inspectUserMessage } from "../src/domain/candidate.ts";

const countSnapshots = <Value extends object>(value: Value) => {
  let snapshots = 0;
  const message = new Proxy(value, {
    ownKeys(target) {
      snapshots += 1;
      return Reflect.ownKeys(target);
    },
  });
  return { message, snapshots: () => snapshots };
};

it("snapshots a user host message once while extracting its text", () => {
  const counted = countSnapshots({
    role: "user",
    content: [
      { type: "text", text: "first" },
      { type: "image", data: "ignored" },
      { type: "text", text: "second" },
    ],
  });

  expect(inspectUserMessage(counted.message)).toBe("first\nsecond");
  expect(counted.snapshots()).toBe(1);
});

it("snapshots an assistant host message once for classification and observations", () => {
  const counted = countSnapshots({
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: " Working " },
      { type: "toolCall", name: "read", arguments: { path: "file.ts" } },
    ],
  });
  const inspection = inspectAssistantMessage(counted.message);

  expect(inspection).toEqual({
    classification: {
      eligible: true,
      candidate: 'Working\n[tool call: read {"path":"file.ts"}]',
      phase: "progress",
    },
    stopReason: "stop",
    toolCalls: ['read {"path":"file.ts"}'],
  });
  expect(counted.snapshots()).toBe(1);
});

it("redacts nested tool credentials in candidate and observation text", () => {
  const inspection = inspectAssistantMessage({
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        name: "fetch",
        arguments: {
          options: {
            openaiApiKey: "nested-api-secret",
            headers: { authorization: "Bearer nested-bearer-secret" },
          },
          tokenCount: 42,
        },
      },
    ],
  });
  const serialized = JSON.stringify(inspection);

  expect(serialized).not.toMatch(/nested-api-secret|nested-bearer-secret/);
  expect(serialized).toContain("[REDACTED]");
  expect(serialized).toContain("tokenCount");
});

it("contains hostile assistant message access without invoking getters", () => {
  let getterCalls = 0;
  const accessorMessage = Object.defineProperties(
    {},
    {
      role: {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("role getter should not run");
        },
      },
      content: {
        enumerable: true,
        value: [{ type: "text", text: "hidden" }],
      },
    },
  );
  const hostileMessage = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("proxy trap should be contained");
      },
    },
  );

  expect(inspectUserMessage(accessorMessage)).toBeUndefined();
  expect(getterCalls).toBe(0);
  let inspection: ReturnType<typeof inspectAssistantMessage> | undefined;
  expect(() => {
    inspection = inspectAssistantMessage(hostileMessage);
  }).not.toThrow();
  expect(inspection).toEqual({
    classification: { eligible: false, reason: "not-assistant" },
    stopReason: "error",
    toolCalls: [],
  });
});
