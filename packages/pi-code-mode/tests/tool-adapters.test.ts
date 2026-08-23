// Boundary adapters over all seven Pi built-ins: deterministic plain-data conversion,
// image refusal, model-safe errors, mutation behavior, and composed nested signals.
// Pi tool execution and hostile hosts are Promise-shaped boundaries.
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { afterEach } from "vitest";
import {
  makeNestedPiToolDefinitions,
  makeNestedPiToolDispatch,
  nestedResultToGuestData,
} from "../src/boundary/host-builtin-tools.ts";
import { ToolError } from "../src/boundary/codemode-runtime.ts";
import { extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = nodeFsModule;
const { join } = nodePathModule;

// JSON here quotes fixture values into guest shell commands; these are code fixtures under
// test control, not schema boundaries.
const quote = (value: string): string => JSON.stringify(value);

class NestedCallAbortedError extends Schema.TaggedError<NestedCallAbortedError>()(
  "NestedCallAbortedError",
  { message: Schema.String },
) {}

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const newCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-adapters-"));
  tempDirectories.push(cwd);
  return cwd;
};

const ctx = extensionContextFixture({
  cwd: "/",
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
});

// A real 1×1 PNG so the built-in read tool takes its genuine image path.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

  it.effect("refuses image content without leaking it into the guest", () =>
    Effect.gen(function* () {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const error = yield* Effect.flip(
        nestedResultToGuestData("read", {
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" } as never],
          details: undefined,
        }),
      );
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain("image content");
      expect(error.message).not.toContain("AAAA");
    }),
  );

  it.effect("refuses unrecognized result shapes model-safely", () =>
    Effect.gen(function* () {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const error = yield* Effect.flip(
        nestedResultToGuestData("grep", { content: "not-an-array" } as never),
      );
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain("unrecognized result shape");
    }),
  );
});

describe("nested dispatch through the real built-in definitions", () => {
  it.effect("reads a real file through an absolute path outside the session cwd", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const elsewhere = newCwd();
      const target = join(elsewhere, "outside.txt");
      writeFileSync(target, "outside the project\n");
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-1",
        signal: undefined,
      });
      const data = yield* dispatch("read", { path: target });
      expect(data).toContain("outside the project");
    }),
  );

  it.effect("lists directories and surfaces built-in errors as model-safe tool failures", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      mkdirSync(join(cwd, "nested"));
      writeFileSync(join(cwd, "nested", "a.txt"), "a");
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-2",
        signal: undefined,
      });
      const listing = yield* dispatch("ls", { path: join(cwd, "nested") });
      expect(listing).toContain("a.txt");

      const error = yield* Effect.flip(dispatch("read", { path: join(cwd, "does-not-exist.txt") }));
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain("Nested tool 'read' failed");
    }),
  );

  it.effect("runs bash and applies unrestricted write/edit operations", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const elsewhere = newCwd();
      const target = join(elsewhere, "nested", "outside.txt");
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-mutate",
        signal: undefined,
      });

      const shell = yield* dispatch("bash", { command: "printf bash-ok" });
      expect(shell).toBe("bash-ok");
      yield* dispatch("write", { path: target, content: "before\n" });
      yield* dispatch("edit", {
        path: target,
        edits: [{ oldText: "before", newText: "after" }],
      });
      expect(readFileSync(target, "utf8")).toBe("after\n");
    }),
  );

  it.effect("surfaces bash nonzero exits as catchable tool failures", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-bash-fail",
        signal: undefined,
      });
      const error = yield* Effect.flip(
        dispatch("bash", { command: "printf before-failure; exit 7" }),
      );
      expect(error.message).toContain("before-failure");
      expect(error.message).toContain("Command exited with code 7");
    }),
  );

  it.live("propagates outer cancellation into a real bash process", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const outer = new AbortController();
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-bash-abort",
        signal: outer.signal,
      });
      const command = `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;
      const pending = yield* Effect.flip(dispatch("bash", { command })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.sleep(50);
      outer.abort();
      const error = yield* Fiber.join(pending);
      expect(error.message).toContain("Command aborted");
    }),
  );

  it.effect("refuses an edit whose old text does not match", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const target = join(cwd, "edit.txt");
      writeFileSync(target, "original\n");
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-edit-refusal",
        signal: undefined,
      });
      const error = yield* Effect.flip(
        dispatch("edit", {
          path: target,
          edits: [{ oldText: "missing", newText: "replacement" }],
        }),
      );
      expect(error.message).toContain("Could not find the exact text");
      expect(readFileSync(target, "utf8")).toBe("original\n");
    }),
  );

  it.effect("refuses image files read through the real read tool", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      writeFileSync(join(cwd, "pixel.png"), PNG_BYTES);
      const dispatch = makeNestedPiToolDispatch({
        definitions: makeNestedPiToolDefinitions(cwd),
        ctx,
        toolCallId: "call-3",
        signal: undefined,
      });
      const error = yield* Effect.flip(dispatch("read", { path: join(cwd, "pixel.png") }));
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain("image");
    }),
  );

  it.effect("hands nested tools a signal composed from the outer signal", () =>
    Effect.gen(function* () {
      const seen: Array<AbortSignal | undefined> = [];
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const definitions = nestedToolDefinitionsFixture({
        read: {
          execute: <Input>(_id: string, _input: Input, signal?: AbortSignal) => {
            seen.push(signal);
            // A deferred-backed promise that settles only by rejecting on abort.
            const gate = Deferred.makeUnsafe<never, NestedCallAbortedError>();
            const rejectAborted = () =>
              void Deferred.doneUnsafe(
                gate,
                Effect.fail(new NestedCallAbortedError({ message: "nested call aborted" })),
              );
            if (signal?.aborted) rejectAborted();
            else signal?.addEventListener("abort", rejectAborted, { once: true });
            return runPromise(Deferred.await(gate));
          },
        },
      });
      const outer = new AbortController();
      const dispatch = makeNestedPiToolDispatch({
        definitions,
        ctx,
        toolCallId: "call-4",
        signal: outer.signal,
      });
      const pending = yield* Effect.flip(dispatch("read", { path: "x" })).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      // Abort the *outer* execute signal; the nested tool observes it through composition.
      outer.abort();
      const error = yield* Fiber.join(pending);
      expect(error).toBeInstanceOf(ToolError);
      expect(error.message).toContain("nested call aborted");
      expect(seen[0]?.aborted).toBe(true);
    }),
  );
});
