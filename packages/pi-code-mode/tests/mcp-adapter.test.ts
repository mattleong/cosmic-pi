import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  mcpCodeModeError,
  normalizeMcpCodeModeQuery,
  type McpCodeModeOutput,
} from "pi-mcp/code-mode";
import { makeMcpDispatch } from "../src/boundary/host-mcp.ts";

const reply = (): McpCodeModeOutput => ({
  action: "status",
  outcome: "completed",
  isError: false,
  data: null,
  notices: [],
});
const capability = <Output>(output: Output, sessionId = "session") => ({
  version: MCP_CODE_MODE_VERSION,
  sessionId,
  execute: () => Promise.resolve(output),
});
const eventsFor = <Candidate>(candidates: ReadonlyArray<Candidate>): ExtensionAPI["events"] => {
  const events = createEventBus();
  events.on(MCP_CODE_MODE_QUERY, (value) => {
    const query = normalizeMcpCodeModeQuery(value);
    for (const candidate of candidates) query?.respond(candidate);
  });
  return events;
};
const dispatchFor = (
  events: ExtensionAPI["events"],
  maxOutputBytes = 1024,
  sessionId: string | undefined = "session",
) =>
  makeMcpDispatch({ events, sessionId, toolCallId: "outer", maxOutputBytes: () => maxOutputBytes });

describe("fixed MCP request adapter", () => {
  it.effect("fails closed for missing, wrong-session, duplicate and invalid providers", () =>
    Effect.gen(function* () {
      for (const candidates of [
        [],
        [capability(reply(), "other")],
        [capability(reply()), capability(reply())],
        [{ version: 2, sessionId: "session", execute: () => Promise.resolve(reply()) }],
      ]) {
        const error = yield* dispatchFor(eventsFor(candidates))({ action: "status" }).pipe(
          Effect.flip,
        );
        expect(error.message).toContain('"outcome":"not-sent"');
        expect(error.message).toContain('"kind":"unavailable"');
      }
      let emitted = false;
      const events = createEventBus();
      events.on(MCP_CODE_MODE_QUERY, () => {
        emitted = true;
      });
      yield* makeMcpDispatch({
        events,
        sessionId: undefined,
        toolCallId: "outer",
        maxOutputBytes: () => 1024,
      })({ action: "status" }).pipe(Effect.flip);
      expect(emitted).toBe(false);
    }),
  );

  it.effect("requeries on each invocation and cannot reuse a withdrawn provider", () =>
    Effect.gen(function* () {
      const events = createEventBus();
      const unsubscribe = events.on(MCP_CODE_MODE_QUERY, (value) =>
        normalizeMcpCodeModeQuery(value)?.respond(capability(reply())),
      );
      const dispatch = dispatchFor(events);
      expect(yield* dispatch({ action: "status" })).toEqual(reply());
      unsubscribe();
      const error = yield* dispatch({ action: "status" }).pipe(Effect.flip);
      expect(error.message).toContain('"kind":"unavailable"');
    }),
  );

  it.effect(
    "rejects malformed, mismatched, binary and aggregate-overbudget replies without payload leakage",
    () =>
      Effect.gen(function* () {
        for (const output of [
          { secret: "DO-NOT-LEAK" },
          { ...reply(), action: "tools.call" },
          { ...reply(), extra: "DO-NOT-LEAK" },
          { ...reply(), data: { type: "image", data: "DO-NOT-LEAK" } },
          { ...reply(), data: "\u0000".repeat(200) },
          { ...reply(), data: Number.NaN },
        ]) {
          const error = yield* dispatchFor(eventsFor([capability(output)]))({
            action: "status",
          }).pipe(Effect.flip);
          expect(error._tag).toBe("ToolError");
          expect(error.message).not.toContain("DO-NOT-LEAK");
        }
      }),
  );

  it.effect("keeps typed execution certainty but never unknown error text or coercion", () =>
    Effect.gen(function* () {
      for (const { rejection, outcome } of [
        { rejection: mcpCodeModeError("output-limit", "completed"), outcome: "completed" },
        { rejection: new Error("DO-NOT-LEAK"), outcome: "unknown" },
        {
          rejection: {
            toString() {
              throw new Error("DO-NOT-LEAK");
            },
          },
          outcome: "unknown",
        },
      ]) {
        const events = eventsFor([
          { ...capability(reply()), execute: () => Promise.reject(rejection) },
        ]);
        const error = yield* dispatchFor(events)({
          action: "tools.call",
          server: "fixture",
          tool: "mutate",
        }).pipe(Effect.flip);
        expect(error.message).toContain('"server":"fixture"');
        expect(error.message).toContain('"tool":"mutate"');
        expect(error.message).not.toContain("DO-NOT-LEAK");
        expect(error.message).toContain(`"outcome":"${outcome}"`);
      }
    }),
  );
});
