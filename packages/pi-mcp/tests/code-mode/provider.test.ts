import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  normalizeMcpCodeModeError,
  type McpCodeModeCapability,
  type McpCodeModeInput,
  type McpCodeModeOutput,
} from "../../src/code-mode/protocol.ts";
import { makeMcpCodeModeHost } from "../../src/boundary/host-code-mode.ts";
import type { McpBoundaryError } from "../../src/client/errors.ts";
import { queryCodeMode } from "../fixtures/application.ts";

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
  return { events, host, query: (sessionId = "session") => queryCodeMode(events, sessionId) };
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

const rejects = <A>(
  run: () => Promise<A>,
  match: Pick<McpBoundaryError, "kind"> & Partial<Pick<McpBoundaryError, "outcome">>,
) => Effect.promise(() => expect(run()).rejects.toMatchObject(match));

const invokeRejected = <Input extends object>(capability: McpCodeModeCapability, input: Input) =>
  capability.execute(
    "invalid",
    // SAFETY: Deliberately malformed test fixtures exercise the public capability's runtime admission.
    input as McpCodeModeInput,
    new AbortController().signal,
    1024,
  );

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
        yield* rejects(() => invoke(candidate), { kind: "unavailable", outcome: "not-sent" });
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
      yield* rejects(() => invoke(old), { kind: "unavailable" });
      const current = h.query()[0]!;
      h.host.deactivate();
      yield* rejects(() => invoke(current), { kind: "unavailable" });
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
        yield* rejects(() => invoke(h.query()[0]!), { kind: "stale", outcome: "completed" });
        h.host.activate(activation(() => Promise.resolve({ ...reply(), data: "x".repeat(2000) })));
        yield* rejects(() => invoke(h.query()[0]!), { kind: "output-limit", outcome: "completed" });
        h.host.dispose();
      }),
  );

  it.effect("exempts schema literals and retained description text by reply action", () =>
    Effect.gen(function* () {
      const h = harness();
      const literals = [
        { blob: "literal-blob" },
        { base64: "literal-base64" },
        { type: "image", data: "literal-image" },
      ];
      const schema = { const: literals, default: literals, enum: [literals], examples: literals };
      const result = { inputSchema: schema, outputSchema: schema };
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(result);
      for (const action of ["tools.describe", "result.read"] as const) {
        const input =
          action === "tools.describe"
            ? { action, server: "one", tool: "run" }
            : { action, id: "retained" };
        const source: McpCodeModeOutput = {
          ...reply(),
          action,
          data:
            action === "tools.describe"
              ? { result }
              : { origin: { action: "tools.describe" }, text },
        };
        h.host.activate(activation(() => Promise.resolve(source)));
        expect(
          yield* Effect.promise(() =>
            h.query()[0]!.execute("schema", input, new AbortController().signal, 8_192),
          ),
        ).toEqual(source);
      }
      h.host.dispose();
    }),
  );

  it.effect("repairs rejected capability inputs without dispatch or rejected data", () =>
    Effect.gen(function* () {
      const h = harness();
      let dispatched = 0;
      h.host.activate(
        activation((_id, input) => {
          dispatched += 1;
          return Promise.resolve({ ...reply(), action: input.action });
        }),
      );
      const capability = h.query()[0]!;
      for (const input of [
        { action: "result.read", server: "PRIVATE_SERVER" },
        { action: "result.read", id: "PRIVATE_ID", offset: -1 },
        { action: "result.read", id: "PRIVATE_ID", PRIVATE_KEY: "PRIVATE_TOKEN" },
      ]) {
        const failure = yield* Effect.tryPromise({
          try: () => invokeRejected(capability, input),
          catch: normalizeMcpCodeModeError,
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({
          kind: "invalid-input",
          outcome: "not-sent",
          requestAction: "result.read",
        });
        expect(failure.message).toContain("requires id");
        expect(failure.message).toContain("nonnegative");
        expect(failure.message).not.toContain("PRIVATE_");
        expect(failure.message).not.toContain("tools.call");
      }
      expect(dispatched).toBe(0);
      const corrected = yield* Effect.promise(() =>
        capability.execute(
          "corrected",
          { action: "result.read", id: "retained", offset: 0 },
          new AbortController().signal,
          1024,
        ),
      );
      expect(corrected).toMatchObject({ action: "result.read", outcome: "completed" });
      expect(dispatched).toBe(1);
      h.host.dispose();
    }),
  );

  it.effect("keeps unsafe and unknown capability inputs generic without invoking getters", () =>
    Effect.gen(function* () {
      const h = harness();
      let dispatched = false;
      let accessed = false;
      h.host.activate(
        activation(() => {
          dispatched = true;
          return Promise.resolve(reply());
        }),
      );
      const capability = h.query()[0]!;
      const accessor = Object.defineProperty({}, "action", {
        enumerable: true,
        get: () => {
          accessed = true;
          return "result.read";
        },
      });
      for (const input of [
        accessor,
        Object.defineProperty({}, "action", {
          get: () => {
            accessed = true;
            return "result.read";
          },
        }),
        Object.defineProperty({ action: "result.read" }, "id", {
          get: () => {
            accessed = true;
            return "PRIVATE_ID";
          },
        }),
        { action: "result.read", id: "x".repeat(1024 * 1024) },
        { action: "PRIVATE_ACTION", PRIVATE_KEY: "PRIVATE_TOKEN" },
        { action: "connect", server: "PRIVATE_SERVER" },
      ]) {
        const failure = yield* Effect.tryPromise({
          try: () => invokeRejected(capability, input),
          catch: normalizeMcpCodeModeError,
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
        expect(failure.requestAction).toBeUndefined();
        expect(failure.message).not.toContain("PRIVATE_");
        expect(failure.message).not.toContain("requires id");
      }
      expect(accessed).toBe(false);
      expect(dispatched).toBe(false);
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
      yield* rejects(() => invoke(h.query()[0]!), { kind: "protocol", outcome: "completed" });
      h.host.dispose();
    }),
  );
});
