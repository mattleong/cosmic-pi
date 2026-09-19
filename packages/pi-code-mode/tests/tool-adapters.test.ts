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
} from "../src/boundary/host-builtin-tools.ts";
import { extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const ctx = extensionContextFixture({
  cwd: "/project",
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
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
      // SAFETY: This fixture deliberately supplies the foreign image branch.
      const error = yield* Effect.flip(
        nestedResultToGuestData("read", {
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" } as never],
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
      // SAFETY: This fixture deliberately supplies malformed foreign output.
      const error = yield* Effect.flip(
        nestedResultToGuestData("grep", { content: "not-an-array" } as never),
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
      const dispatch = makeNestedPiToolDispatch({
        definitions: nestedToolDefinitionsFixture({ read: definition, bash: definition }),
        ctx,
        toolCallId: "outer",
      });

      const returned = [
        yield* dispatch("read", { path: "a" }),
        yield* dispatch("bash", { command: "true" }),
        yield* dispatch("read", { path: "b" }),
      ];
      expect(new Set(ids).size).toBe(3);
      expect(returned).toEqual(ids);
      const other = makeNestedPiToolDispatch({
        definitions: nestedToolDefinitionsFixture({ read: definition }),
        ctx,
        toolCallId: "other-outer",
      });
      expect(yield* other("read", { path: "a" })).not.toBe(returned[0]);
      expect(new Set(ids).size).toBe(4);
    }),
  );

  it.effect("passes Effect interruption directly to the nested definition", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const seen: AbortSignal[] = [];
      const dispatch = makeNestedPiToolDispatch({
        definitions: nestedToolDefinitionsFixture({
          read: {
            execute: <Input>(_id: string, _input: Input, signal: AbortSignal) => {
              seen.push(signal);
              void Deferred.doneUnsafe(started, Effect.void);
              return Promise.race([]);
            },
          },
        }),
        ctx,
        toolCallId: "outer",
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

  it.effect("contains hostile rejection coercion at the adapter boundary", () =>
    Effect.gen(function* () {
      const dispatch = makeNestedPiToolDispatch({
        definitions: nestedToolDefinitionsFixture({
          read: {
            execute: () =>
              Promise.reject({
                toString: () => {
                  throw new Error("toString escaped");
                },
              }),
          },
        }),
        ctx,
        toolCallId: "outer",
      });
      const error = yield* dispatch("read", { path: "x" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ToolError",
        message: "Nested tool 'read' failed: Unknown rejection",
      });
    }),
  );
});
