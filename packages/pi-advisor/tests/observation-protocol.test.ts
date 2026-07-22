import { describe, expect, test } from "vitest";
import {
  AdvisorObservationBuffer,
  MAX_OBSERVATION_CHANNEL_CHARS,
  MAX_OBSERVATION_RECORDS,
  OBSERVATION_OMISSION_MARKER,
  stringifyRedactedObservation,
} from "../src/review/observation-protocol.ts";

describe("observation protocol", () => {
  test("does not invoke accessors or Proxy traps while snapshotting observations", () => {
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap executed");
        },
      },
    );
    expect(stringifyRedactedObservation(accessor)).toBe("{}");
    expect(stringifyRedactedObservation(hostile)).toBe("[unavailable]");
  });
  test("fails observation ingress closed without invoking accessors or leaking Proxy errors", () => {
    const buffer = new AdvisorObservationBuffer();
    let getterCalls = 0;
    const accessor = Object.defineProperties(
      {},
      {
        type: { enumerable: true, value: "assistant_text_delta" },
        text: {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error("getter executed");
          },
        },
      },
    );
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap executed");
        },
      },
    );

    expect(() => buffer.ingest(1, accessor as never)).toThrow(/observation/i);
    expect(getterCalls).toBe(0);
    expect(() => buffer.ingest(1, hostile as never)).toThrow(/observation/i);
  });

  test("assigns monotonic sequence and coalesces text and thinking by channel", () => {
    const buffer = new AdvisorObservationBuffer(7);
    buffer.ingest(1, { type: "assistant_thinking_delta", text: "reason " });
    buffer.ingest(1, { type: "assistant_thinking_delta", text: "more" });
    buffer.ingest(1, { type: "assistant_text_delta", text: "answer " });
    buffer.ingest(1, { type: "assistant_text_delta", text: "done" });
    const batch = buffer.takeThrough();

    expect(batch?.lastSequence).toBe(4);
    expect(batch?.observations.map((record) => record.type)).toEqual([
      "assistant_thinking_delta",
      "assistant_text_delta",
    ]);
    expect(batch?.rendered).toContain("reason more");
    expect(batch?.rendered).toContain("answer done");
  });

  test("keeps interleaved tool updates in monotonic causal order", () => {
    const buffer = new AdvisorObservationBuffer();
    buffer.ingest(1, { type: "tool_start", toolCallId: "c", toolName: "read", args: "{}" });
    buffer.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "old" });
    buffer.ingest(1, { type: "assistant_text_delta", text: "intervening" });
    buffer.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "new" });
    buffer.ingest(1, {
      type: "tool_end",
      toolCallId: "c",
      toolName: "read",
      result: "ok",
      isError: false,
    });
    const observations = buffer.takeThrough()?.observations ?? [];

    expect(observations.map((record) => record.sequence)).toEqual([1, 3, 4, 5]);
    expect(observations.map((record) => record.type)).toEqual([
      "tool_start",
      "assistant_text_delta",
      "tool_update",
      "tool_end",
    ]);
  });

  test("freezes seq1 tool_update against seq2 same-tool pre-pump replacement", () => {
    const buffer = new AdvisorObservationBuffer();
    buffer.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq1" });
    buffer.freezeThrough(1);
    buffer.ingest(1, { type: "tool_update", toolCallId: "c", toolName: "read", update: "seq2" });

    expect(buffer.peekThrough(1)?.rendered).toContain("seq1");
    expect(buffer.peekThrough(1)?.rendered).not.toContain("seq2");
    expect(buffer.peekThrough(2)?.observations.map((record) => record.sequence)).toEqual([1, 2]);
  });

  test("bounds high-frequency ingestion and emits an explicit omission marker", () => {
    const buffer = new AdvisorObservationBuffer();
    for (let index = 0; index < MAX_OBSERVATION_RECORDS * 4; index += 1) {
      buffer.ingest(index, { type: "assistant_text_delta", text: "x".repeat(1_000) });
    }
    const batch = buffer.takeThrough();
    expect(batch?.observations.length).toBeLessThanOrEqual(MAX_OBSERVATION_RECORDS + 1);
    expect(batch?.rendered).toContain(OBSERVATION_OMISSION_MARKER);
    const sequences = batch?.observations.map((record) => record.sequence) ?? [];
    expect(sequences).toEqual([...new Set(sequences)].sort((left, right) => left - right));
    expect(batch?.rendered.length).toBeLessThan(80_000);
  });

  test("renders bounded structured tool-loop evidence chronologically", () => {
    const buffer = new AdvisorObservationBuffer(3);
    buffer.ingest(8, { type: "tool_start", toolCallId: "c", toolName: "read", args: "a" });
    buffer.ingest(8, {
      type: "trajectory_signal",
      kind: "repeated-inspection",
      confidence: "strong",
      reason: "r".repeat(20_000),
      evidence: "bounded fingerprint",
      abortSafe: true,
    });
    const rendered = buffer.peekThrough()?.rendered ?? "";
    expect(rendered.indexOf("tool_start")).toBeLessThan(rendered.indexOf("trajectory_signal"));
    expect(rendered).toContain("bounded fingerprint");
    expect(rendered.length).toBeLessThan(20_000);
  });

  test("redacts credentials recursively across text, tool arguments, updates and results", () => {
    const buffer = new AdvisorObservationBuffer();
    buffer.ingest(1, { type: "assistant_text_delta", text: "Authorization: Bearer abc.def" });
    buffer.ingest(1, {
      type: "tool_start",
      toolCallId: "c",
      toolName: "read",
      args: JSON.stringify({ nested: { apiKey: "sk-abcdefghijklmnop" } }),
    });
    buffer.ingest(1, {
      type: "tool_update",
      toolCallId: "c",
      toolName: "read",
      update: "access_token=secret-value",
    });
    buffer.ingest(1, {
      type: "tool_end",
      toolCallId: "c",
      toolName: "read",
      result: "password=hunter2",
      isError: false,
    });
    const rendered = buffer.takeThrough()?.rendered ?? "";
    expect(rendered).not.toMatch(/abc\.def|sk-abcdefghijklmnop|secret-value|hunter2/);
    expect(rendered).toContain("REDACTED");
  });

  test("keeps assistant_final causally before turn_complete", () => {
    const buffer = new AdvisorObservationBuffer();
    buffer.ingest(1, { type: "assistant_final", text: "done", toolCalls: [] });
    buffer.ingest(1, { type: "turn_complete", status: "stop" });
    expect(buffer.takeThrough()?.observations.map((record) => record.type)).toEqual([
      "assistant_final",
      "turn_complete",
    ]);
  });

  test("records bounded intervention delivery and receipt facts without critique text", () => {
    const buffer = new AdvisorObservationBuffer();
    const id = "af_0123456789abcdef0123456789abcdef";
    buffer.ingest(3, {
      type: "advisor_intervention",
      findingIds: [id, "invalid-secret-id"],
      action: "revision",
      requestSequence: 2,
    });
    buffer.ingest(4, {
      type: "advisor_intervention_receipt",
      findingIds: [id],
      requestSequence: 2,
    });
    const rendered = buffer.takeThrough()?.rendered ?? "";
    expect(rendered).toContain("advisor_intervention");
    expect(rendered).toContain("advisor_intervention_receipt");
    expect(rendered).toContain(id);
    expect(rendered).not.toContain("invalid-secret-id");
  });

  test("retains intervention facts under observation pressure", () => {
    const buffer = new AdvisorObservationBuffer();
    const id = "af_0123456789abcdef0123456789abcdef";
    buffer.ingest(1, {
      type: "advisor_intervention",
      findingIds: [id],
      action: "revision",
      requestSequence: 1,
    });
    buffer.ingest(1, {
      type: "advisor_intervention_receipt",
      findingIds: [id],
      requestSequence: 1,
    });
    for (let index = 0; index < MAX_OBSERVATION_RECORDS * 2; index += 1) {
      buffer.ingest(1, {
        type: "assistant_text_delta",
        text: `noise-${index}-${"x".repeat(1_000)}`,
      });
    }
    for (let index = 0; index < MAX_OBSERVATION_RECORDS * 2; index += 1) {
      buffer.ingest(1, { type: "turn_complete", status: "stop" });
    }
    const types = buffer.takeThrough()?.observations.map((record) => record.type) ?? [];
    expect(types).toContain("advisor_intervention");
    expect(types).toContain("advisor_intervention_receipt");
  });

  test("caps a single streamed channel", () => {
    const buffer = new AdvisorObservationBuffer();
    for (let index = 0; index < 100; index += 1) {
      buffer.ingest(1, { type: "assistant_thinking_delta", text: "z".repeat(1_000) });
    }
    const record = buffer.takeThrough()?.observations.at(-1);
    expect(record?.type).toBe("assistant_thinking_delta");
    if (record?.type === "assistant_thinking_delta") {
      expect(record.text.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHANNEL_CHARS);
    }
  });
});
