// Owned boundary behavior over fake Pi definitions: plain-data conversion, deterministic ids,
// Effect-owned interruption signals, image refusal, and total foreign-error mapping.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  makeNestedPiToolDefinitions,
  makeNestedPiToolDispatch,
  nestedResultToGuestData,
  type NestedDispatchOptions,
} from "../src/boundary/host-builtin-tools.ts";
import { extensionContextFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { truncation } from "./support/read.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const ctx = extensionContextFixture({ cwd: "/project" });

const dispatchWith = <Definitions extends object>(
  definitions: Definitions,
  extra: Partial<NestedDispatchOptions> = {},
) =>
  makeNestedPiToolDispatch({
    definitions: nestedToolDefinitionsFixture(definitions),
    ctx,
    toolCallId: "outer",
    ...extra,
  });

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

describe("nestedResultToGuestData", () => {
  it.effect("joins text blocks deterministically", () =>
    Effect.gen(function* () {
      const data = yield* nestedResultToGuestData("read", {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        details: undefined,
      });
      expect(data).toBe("line one\nline two");
    }),
  );

  it.effect("refuses constructed image content without leaking it into the guest", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nestedResultToGuestData("read", {
          content: [opaqueFixture({ type: "image", data: "AAAA", mimeType: "image/png" })],
          details: undefined,
        }),
      );
      expect(error).toMatchObject({ _tag: "ToolError" });
      expect(error.message).toContain("image content");
      expect(error.message).not.toContain("AAAA");
    }),
  );

  it.effect("refuses unrecognized result shapes model-safely", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        nestedResultToGuestData("grep", opaqueFixture({ content: "not-an-array" })),
      );
      expect(error).toMatchObject({ _tag: "ToolError" });
      expect(error.message).toContain("unrecognized result shape");
    }),
  );
});

describe("nested definition factory", () => {
  it("adds Pi's PowerShell definition only for Windows", () => {
    expect(makeNestedPiToolDefinitions("/project", "darwin").powershell).toBeUndefined();
    expect(makeNestedPiToolDefinitions("C:\\project", "win32").powershell).toBeDefined();
  });
});

describe("nested dispatch", () => {
  it.effect("correlates unique nested ids with their returned invocation", () =>
    Effect.gen(function* () {
      const ids: string[] = [];
      const definition = {
        execute: (id: string) => {
          ids.push(id);
          return Promise.resolve(textResult(id));
        },
      };
      const dispatch = dispatchWith({ read: definition, bash: definition });

      const returned = [
        yield* dispatch("read", { path: "a" }),
        yield* dispatch("bash", { command: "true" }),
        yield* dispatch("read", { path: "b" }),
      ];
      expect(new Set(ids).size).toBe(3);
      expect(returned).toEqual(ids);
      const other = dispatchWith({ read: definition }, { toolCallId: "other-outer" });
      expect(yield* other("read", { path: "a" })).not.toBe(returned[0]);
      expect(new Set(ids).size).toBe(4);
    }),
  );

  it.effect("passes Effect interruption directly to the nested definition", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const seen: AbortSignal[] = [];
      const dispatch = dispatchWith({
        read: {
          execute: <Input>(_id: string, _input: Input, signal: AbortSignal) => {
            seen.push(signal);
            void Deferred.doneUnsafe(started, Effect.void);
            return Promise.race([]);
          },
        },
      });

      const fiber = yield* dispatch("read", { path: "wait" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.aborted).toBe(true);
    }),
  );

  it.effect("strips read controls before native dispatch and preserves structured text", () =>
    Effect.gen(function* () {
      const received: Array<{ id: string; input: unknown }> = [];
      const dispatch = dispatchWith({
        read: {
          execute: <Input>(id: string, input: Input) => {
            received.push({ id, input });
            return Promise.resolve(textResult("complete α"));
          },
        },
      });

      expect(
        yield* dispatch("read", {
          path: "fixture",
          offset: 1,
          format: "structured",
          requireComplete: true,
        }),
      ).toEqual({ text: "complete α", completeness: "complete" });
      expect(received).toEqual([{ id: "outer/read/1", input: { path: "fixture", offset: 1 } }]);
    }),
  );

  it.effect("rejects scoped complete reads before dispatch without consuming a native id", () =>
    Effect.gen(function* () {
      const received: string[] = [];
      const dispatch = dispatchWith({
        read: {
          execute: (id: string) => {
            received.push(id);
            return Promise.resolve(textResult("whole"));
          },
        },
      });

      for (const scoped of [{ limit: 1 }, { offset: 2 }]) {
        const error = yield* dispatch("read", {
          path: "fixture",
          ...scoped,
          requireComplete: true,
        }).pipe(Effect.flip);
        expect(error.message).toContain("was not sent");
      }
      expect(received).toEqual([]);
      expect(yield* dispatch("read", { path: "fixture" })).toBe("whole");
      expect(received).toEqual(["outer/read/1"]);
    }),
  );

  it.effect("records completed native work before refusing incomplete delivery", () =>
    Effect.gen(function* () {
      const operations: string[] = [];
      const deliveryFailures: Array<number | undefined> = [];
      const details = {
        truncation: truncation({
          content: "partial",
          totalLines: 2,
          totalBytes: 15,
          outputLines: 1,
          outputBytes: 7,
        }),
      };
      const dispatch = dispatchWith(
        {
          read: {
            execute: () =>
              Promise.resolve({
                content: [{ type: "text" as const, text: "partial\n\n[native footer]" }],
                details,
              }),
          },
        },
        {
          observationId: () => 41,
          onOperation: (_id, certainty) => operations.push(certainty),
          onDeliveryFailure: (id) => deliveryFailures.push(id),
        },
      );

      const error = yield* dispatch("read", {
        path: "fixture",
        requireComplete: true,
      }).pipe(Effect.flip);
      expect(error.message).toContain("completed");
      expect(error.message).toContain("native-truncation");
      expect(operations).toEqual(["unknown", "completed"]);
      expect(deliveryFailures).toEqual([41]);
    }),
  );

  it.effect("contains hostile rejection coercion at the adapter boundary", () =>
    Effect.gen(function* () {
      const dispatch = dispatchWith({
        read: {
          execute: () =>
            Promise.reject({
              toString: () => {
                throw new Error("toString escaped");
              },
            }),
        },
      });
      const error = yield* dispatch("read", { path: "x" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ToolError",
        message: "Nested tool 'read' failed: Unknown rejection",
      });
    }),
  );
});
