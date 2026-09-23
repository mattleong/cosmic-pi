import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodeModeConfig } from "../src/config/schema.ts";
import {
  type NestedPiToolDefinitions,
  type PiGuestToolInput,
} from "../src/boundary/host-builtin-tools.ts";
import { makeCodeModeToolExecute } from "../src/tools/execution.ts";
import { utf8ByteLength } from "../src/tools/limits.ts";
import {
  decodeReadGuestInput,
  REQUIRE_COMPLETE_INPUT_REFUSAL,
  StructuredReadResultSchema,
  type StructuredReadResult,
} from "../src/tools/read-result.ts";
import { codeModeStateFixture, extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const context = extensionContextFixture({
  cwd: "/project",
  sessionManager: {
    getSessionId: () => "complete-read",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
});

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

const parseGuestJson = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  JSON.parse(textOf(result));

interface NativeTruncationFixture {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

interface NativeReadDetailsFixture {
  truncation: Partial<NativeTruncationFixture>;
}

interface NativeTextResult {
  content: Array<{ type: "text"; text: string }>;
  details: NativeReadDetailsFixture | undefined;
}

const nativeText = (text: string, details?: NativeReadDetailsFixture): NativeTextResult => ({
  content: [{ type: "text", text }],
  details,
});

const inputPath = <Input>(input: Input): string | undefined => decodeReadGuestInput(input)?.path;

const nativeTruncation = (
  overrides: Partial<NativeTruncationFixture> = {},
): NativeTruncationFixture => ({
  content: "first",
  truncated: true,
  truncatedBy: "lines",
  totalLines: 2,
  totalBytes: 12,
  outputLines: 1,
  outputBytes: 5,
  lastLinePartial: false,
  firstLineExceedsLimit: false,
  maxLines: 2_000,
  maxBytes: 51_200,
  ...overrides,
});

type ReadExecute = (id: string, input: PiGuestToolInput) => Promise<NativeTextResult>;

const definitionsWith = (
  read: ReadExecute,
  edit?: (input: PiGuestToolInput) => Promise<NativeTextResult>,
): NestedPiToolDefinitions =>
  nestedToolDefinitionsFixture({
    read: { execute: read },
    edit: {
      execute: (_id: string, input: PiGuestToolInput) =>
        edit?.(input) ?? Promise.resolve(nativeText("edited")),
    },
  });

const executeWith = (
  definitions: NestedPiToolDefinitions,
  config: Partial<CodeModeConfig> = {},
  retainFailureDetails?: Parameters<typeof makeCodeModeToolExecute>[0]["retainFailureDetails"],
) => {
  const state = codeModeStateFixture(config);
  const base = {
    isCurrent: () => true,
    getState: () => state,
    runInSession: <A>(effect: Effect.Effect<A>, signal?: AbortSignal) =>
      Effect.runPromise(effect, signal === undefined ? undefined : { signal }),
    definitions,
    events: createEventBus(),
    sessionId: "complete-read",
  };
  const environment = retainFailureDetails === undefined ? base : { ...base, retainFailureDetails };
  const execute = makeCodeModeToolExecute(environment);
  return (id: string, code: string) => execute(id, { code }, undefined, undefined, context);
};

describe("complete read execution", () => {
  it.effect("prevents a later mutation when settled read output is truncated", () =>
    Effect.gen(function* () {
      let edits = 0;
      const retained: Array<{ details: { executionReceipts?: unknown } }> = [];
      const execute = executeWith(
        definitionsWith(
          () =>
            Promise.resolve(
              nativeText("first\n\n[Showing line 1 of 2. Use offset=2 to continue.]", {
                truncation: nativeTruncation(),
              }),
            ),
          () => {
            edits += 1;
            return Promise.resolve(nativeText("edited"));
          },
        ),
        {},
        (_id, details) => retained.push({ details }),
      );
      const message = yield* Effect.promise(() =>
        execute(
          "truncated-guard",
          `
            await tools.pi.read({ path: "fixture", requireComplete: true });
            await tools.pi.edit({
              path: "fixture",
              edits: [{ oldText: "before", newText: "after" }]
            });
            return "unexpected mutation";
          `,
        ).then(
          () => "unexpected success",
          (error) => (error instanceof Error ? error.message : String(error)),
        ),
      );

      expect(message).toContain("requireComplete refused its output");
      expect(edits).toBe(0);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.details.executionReceipts).toMatchObject({
        total: 1,
        completed: 1,
        notSent: 0,
        calls: [
          expect.objectContaining({
            tool: "pi.read",
            certainty: "completed",
            delivery: "not-delivered",
          }),
        ],
      });
    }),
  );

  it.effect("permits a later edit after one complete native read", () =>
    Effect.gen(function* () {
      const readInputs: unknown[] = [];
      let edits = 0;
      const execute = executeWith(
        definitionsWith(
          (_id, input) => {
            readInputs.push(input);
            return Promise.resolve(nativeText("whole α"));
          },
          () => {
            edits += 1;
            return Promise.resolve(nativeText("edited"));
          },
        ),
      );
      const result = yield* Effect.promise(() =>
        execute(
          "complete-then-edit",
          `
            const text = await tools.pi.read({
              path: "fixture",
              format: "text",
              requireComplete: true
            });
            const edited = await tools.pi.edit({
              path: "fixture",
              edits: [{ oldText: "before", newText: "after" }]
            });
            return text + "|" + edited;
          `,
        ),
      );

      expect(textOf(result)).toBe("whole α|edited");
      expect(readInputs).toEqual([{ path: "fixture" }]);
      expect(edits).toBe(1);
    }),
  );

  it.effect("keeps default text exact and returns opt-in structured metadata", () =>
    Effect.gen(function* () {
      const text = "first\n\n[Showing line 1 of 2. Use offset=2 to continue.]";
      const inputs: unknown[] = [];
      const execute = executeWith(
        definitionsWith((_id, input) => {
          inputs.push(input);
          return Promise.resolve(nativeText(text, { truncation: nativeTruncation() }));
        }),
      );
      const result = yield* Effect.promise(() =>
        execute(
          "read-formats",
          `
            const plain = await tools.pi.read({ path: "fixture" });
            const structured = await tools.pi.read({ path: "fixture", format: "structured" });
            return { plain, structured };
          `,
        ),
      );

      expect(parseGuestJson(result)).toEqual({
        plain: text,
        structured: {
          text,
          completeness: "partial",
          reason: "native-truncation",
          truncatedBy: "lines",
          nextOffset: 2,
        },
      });
      expect(inputs).toEqual([{ path: "fixture" }, { path: "fixture" }]);
    }),
  );

  it.effect("keeps limited, malformed, and image-diagnostic completeness conservative", () =>
    Effect.gen(function* () {
      const inputs: PiGuestToolInput[] = [];
      const execute = executeWith(
        definitionsWith((_id, input) => {
          inputs.push(input);
          if (inputPath(input) === "limited")
            return Promise.resolve(
              nativeText("one\n\n[2 more lines in file. Use offset=2 to continue.]"),
            );
          if (inputPath(input) === "image")
            return Promise.resolve(
              nativeText("Read image file [image/tiff]\n[Image omitted: conversion failed.]"),
            );
          return Promise.resolve(
            nativeText("plain", { truncation: { truncated: true, truncatedBy: "lines" } }),
          );
        }),
      );
      const result = yield* Effect.promise(() =>
        execute(
          "conservative-read-metadata",
          `
            return await Promise.all([
              tools.pi.read({ path: "limited", limit: 1, format: "structured" }),
              tools.pi.read({ path: "malformed", format: "structured" }),
              tools.pi.read({ path: "image", format: "structured" })
            ]);
          `,
        ),
      );

      expect(parseGuestJson(result)).toEqual([
        expect.objectContaining({ completeness: "unknown", reason: "limited-read" }),
        { text: "plain", completeness: "unknown", reason: "metadata-unavailable" },
        {
          text: "Read image file [image/tiff]\n[Image omitted: conversion failed.]",
          completeness: "unknown",
          reason: "metadata-unavailable",
        },
      ]);
      expect(inputs).toEqual(
        expect.arrayContaining([
          { path: "limited", limit: 1 },
          { path: "malformed" },
          { path: "image" },
        ]),
      );
    }),
  );

  it.effect("charges structured Unicode JSON exactly once", () =>
    Effect.gen(function* () {
      const structured: StructuredReadResult = { text: "é🔥", completeness: "complete" };
      const serialized = yield* Schema.encodeEffect(
        Schema.fromJsonString(StructuredReadResultSchema),
      )(structured);
      const exactBytes = utf8ByteLength(serialized);
      const definitions = definitionsWith(() => Promise.resolve(nativeText(structured.text)));

      const admitted = yield* Effect.promise(() =>
        executeWith(definitions, { maxCumulativeChildOutputBytes: exactBytes })(
          "unicode-exact",
          `return await tools.pi.read({ path: "unicode", format: "structured" });`,
        ),
      );
      expect(textOf(admitted)).toBe(serialized);

      const refused = yield* Effect.promise(() =>
        executeWith(definitions, { maxCumulativeChildOutputBytes: exactBytes - 1 })(
          "unicode-over",
          `
            try {
              await tools.pi.read({ path: "unicode", format: "structured" });
              return "unexpected";
            } catch (error) {
              return error.message;
            }
          `,
        ),
      );
      expect(utf8ByteLength(textOf(refused))).toBe(exactBytes - 1);
      expect(textOf(refused)).not.toContain("�");
    }),
  );

  it.effect("atomically admits concurrent structured reads and concurrent guard refusals", () =>
    Effect.gen(function* () {
      const structured: StructuredReadResult = { text: "é", completeness: "complete" };
      const serialized = yield* Schema.encodeEffect(
        Schema.fromJsonString(StructuredReadResultSchema),
      )(structured);
      const oneReadBytes = utf8ByteLength(serialized);
      let nativeReads = 0;
      const definitions = definitionsWith(() => {
        nativeReads += 1;
        return Promise.resolve(nativeText(structured.text));
      });
      const readResult = yield* Effect.promise(() =>
        executeWith(definitions, { maxCumulativeChildOutputBytes: oneReadBytes })(
          "concurrent-structured",
          `
            const calls = ["a", "b"].map(path =>
              tools.pi.read({ path, format: "structured" }).then(
                value => ({ ok: true, value }),
                error => ({ ok: false, message: error.message })
              )
            );
            return await Promise.all(calls);
          `,
        ),
      );
      // SAFETY: The guest program returns only the two literal settlement object shapes above.
      const settled = parseGuestJson(readResult) as Array<{
        ok: boolean;
        value?: unknown;
        message?: string;
      }>;
      expect(settled.filter(({ ok }) => ok)).toHaveLength(1);
      expect(settled.filter(({ ok }) => !ok)).toEqual([{ ok: false, message: "" }]);
      expect(nativeReads).toBe(2);

      nativeReads = 0;
      const guardResult = yield* Effect.promise(() =>
        executeWith(definitions, {
          maxCumulativeChildOutputBytes: utf8ByteLength(REQUIRE_COMPLETE_INPUT_REFUSAL),
        })(
          "concurrent-guards",
          `
            const calls = ["a", "b"].map(path =>
              tools.pi.read({ path, limit: 1, requireComplete: true }).then(
                () => "unexpected",
                error => error.message
              )
            );
            return await Promise.all(calls);
          `,
        ),
      );
      // SAFETY: Both guest branches return error.message strings.
      const messages = parseGuestJson(guardResult) as string[];
      expect(messages.sort((left, right) => left.length - right.length)).toEqual([
        "",
        REQUIRE_COMPLETE_INPUT_REFUSAL,
      ]);
      expect(nativeReads).toBe(0);
    }),
  );
});
