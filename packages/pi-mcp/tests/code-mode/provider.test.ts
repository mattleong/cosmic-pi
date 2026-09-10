import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeCapability,
  type McpCodeModeCapability,
  type McpCodeModeOutput,
} from "../../src/code-mode/protocol.ts";
import { makeMcpCodeModeHost } from "../../src/boundary/host-code-mode.ts";

const reply = (): McpCodeModeOutput => ({
  action: "status",
  outcome: "completed",
  isError: false,
  data: { servers: [] },
  notices: [],
});
const harness = () => {
  const events = createEventBus();
  const host = makeMcpCodeModeHost(events);
  const query = (sessionId = "session") => {
    const found: McpCodeModeCapability[] = [];
    events.emit(MCP_CODE_MODE_QUERY, {
      version: MCP_CODE_MODE_VERSION,
      sessionId,
      respond: <Value>(value: Value) => {
        const candidate = normalizeMcpCodeModeCapability(value);
        if (candidate) found.push(candidate);
      },
    });
    return found;
  };
  return { events, host, query };
};
const activation = (
  execute: McpCodeModeCapability["execute"] = () => Promise.resolve(reply()),
) => ({
  sessionId: "session",
  tokenCurrent: () => true,
  toolActive: () => true,
  trusted: () => true,
  execute,
});
const invoke = (capability: McpCodeModeCapability) =>
  capability.execute("outer/mcp/1", { action: "status" }, new AbortController().signal, 1024);

describe("MCP session capability producer", () => {
  it.effect("gates queries and retained execution on every live authority check", () =>
    Effect.gen(function* () {
      for (const gate of ["tokenCurrent", "toolActive", "trusted"] as const) {
        const h = harness();
        let enabled = true;
        let executed = false;
        h.host.activate({
          ...activation(() => {
            executed = true;
            return Promise.resolve(reply());
          }),
          [gate]: () => enabled,
        });
        const candidate = h.query()[0]!;
        expect(h.query("other")).toHaveLength(0);
        enabled = false;
        expect(h.query()).toHaveLength(0);
        yield* Effect.promise(() =>
          expect(invoke(candidate)).rejects.toMatchObject({
            kind: "unavailable",
            outcome: "not-sent",
          }),
        );
        expect(executed).toBe(false);
        h.host.dispose();
      }
    }),
  );

  it.effect("revokes synchronously on replacement, deactivation and disposal", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(h.query()).toHaveLength(0);
      h.host.activate(activation());
      const old = h.query()[0]!;
      h.host.activate(activation());
      yield* Effect.promise(() =>
        expect(invoke(old)).rejects.toMatchObject({ kind: "unavailable" }),
      );
      const current = h.query()[0]!;
      h.host.deactivate();
      yield* Effect.promise(() =>
        expect(invoke(current)).rejects.toMatchObject({ kind: "unavailable" }),
      );
      h.host.dispose();
      h.host.activate(activation());
      expect(h.query()).toHaveLength(0);
    }),
  );

  it.effect(
    "forwards exact cancellation, call identity and allowance and detaches accepted JSON",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const source = reply();
        const signal = new AbortController().signal;
        let captured: unknown;
        h.host.activate(
          activation((...args) => {
            captured = args;
            return Promise.resolve(source);
          }),
        );
        const received = yield* Effect.promise(() =>
          h.query()[0]!.execute("call-id", { action: "status" }, signal, 333),
        );
        expect(captured).toEqual(["call-id", { action: "status" }, signal, 333]);
        expect(received).toEqual(source);
        expect(received.data).not.toBe(source.data);
        h.host.dispose();
      }),
  );

  it.effect(
    "refuses overbudget output and late revoked publication without losing completion",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.host.activate(
          activation(() => {
            h.host.deactivate();
            return Promise.resolve(reply());
          }),
        );
        yield* Effect.promise(() =>
          expect(invoke(h.query()[0]!)).rejects.toMatchObject({
            kind: "stale",
            outcome: "completed",
          }),
        );
        h.host.activate(activation(() => Promise.resolve({ ...reply(), data: "x".repeat(2000) })));
        yield* Effect.promise(() =>
          expect(invoke(h.query()[0]!)).rejects.toMatchObject({
            kind: "output-limit",
            outcome: "completed",
          }),
        );
        h.host.dispose();
      }),
  );

  it.effect("rejects binary envelopes rather than passing images through JSON", () =>
    Effect.gen(function* () {
      const h = harness();
      h.host.activate(
        activation(() =>
          Promise.resolve({
            ...reply(),
            data: { type: "image", data: "base64-secret", mimeType: "image/png" },
          }),
        ),
      );
      yield* Effect.promise(() =>
        expect(invoke(h.query()[0]!)).rejects.toMatchObject({
          kind: "protocol",
          outcome: "completed",
        }),
      );
      h.host.dispose();
    }),
  );
});
