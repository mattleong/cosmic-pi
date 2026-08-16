// Boundary adapters over all seven Pi built-ins: deterministic plain-data conversion,
// image refusal, model-safe errors, mutation behavior, and composed nested signals.
// Pi tool execution and hostile hosts are Promise-shaped boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/globalTimers:off
import { runtimeTypeName } from "pi-cosmic-core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeNestedPiToolDefinitions,
  makeNestedPiToolDispatch,
  nestedResultToGuestData,
  PI_GUEST_TOOL_NAMES,
} from "../src/boundary/host-builtin-tools.ts";
import { ToolError } from "../src/boundary/codemode-runtime.ts";
import { extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

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
  it("joins text blocks deterministically", async () => {
    const data = await Effect.runPromise(
      nestedResultToGuestData("read", {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
        details: undefined,
      }),
    );
    expect(data).toBe("line one\nline two");
  });

  it("refuses image content without leaking it into the guest", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const error = await Effect.runPromise(
      Effect.flip(
        nestedResultToGuestData("read", {
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" } as never],
          details: undefined,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("image content");
    expect(error.message).not.toContain("AAAA");
  });

  it("refuses unrecognized result shapes model-safely", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const error = await Effect.runPromise(
      Effect.flip(nestedResultToGuestData("grep", { content: "not-an-array" } as never)),
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("unrecognized result shape");
  });
});

describe("nested dispatch through the real built-in definitions", () => {
  it("constructs exactly all seven Pi built-ins", () => {
    const definitions = makeNestedPiToolDefinitions(newCwd());
    expect(PI_GUEST_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(Object.keys(definitions)).toEqual(PI_GUEST_TOOL_NAMES);
    for (const name of PI_GUEST_TOOL_NAMES) {
      expect(definitions[name].name).toBe(name);
      expect(runtimeTypeName(definitions[name].execute)).toBe("function");
    }
  });

  it("reads a real file through an absolute path outside the session cwd", async () => {
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
    const data = await Effect.runPromise(dispatch("read", { path: target }));
    expect(data).toContain("outside the project");
  });

  it("lists directories and surfaces built-in errors as model-safe tool failures", async () => {
    const cwd = newCwd();
    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "a.txt"), "a");
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-2",
      signal: undefined,
    });
    const listing = await Effect.runPromise(dispatch("ls", { path: join(cwd, "nested") }));
    expect(listing).toContain("a.txt");

    const error = await Effect.runPromise(
      Effect.flip(dispatch("read", { path: join(cwd, "does-not-exist.txt") })),
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("Nested tool 'read' failed");
  });

  it("runs bash and applies unrestricted write/edit operations", async () => {
    const cwd = newCwd();
    const elsewhere = newCwd();
    const target = join(elsewhere, "nested", "outside.txt");
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-mutate",
      signal: undefined,
    });

    const shell = await Effect.runPromise(dispatch("bash", { command: "printf bash-ok" }));
    expect(shell).toBe("bash-ok");
    await Effect.runPromise(dispatch("write", { path: target, content: "before\n" }));
    await Effect.runPromise(
      dispatch("edit", {
        path: target,
        edits: [{ oldText: "before", newText: "after" }],
      }),
    );
    expect(readFileSync(target, "utf8")).toBe("after\n");
  });

  it("surfaces bash nonzero exits as catchable tool failures", async () => {
    const cwd = newCwd();
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-bash-fail",
      signal: undefined,
    });
    const error = await Effect.runPromise(
      Effect.flip(dispatch("bash", { command: "printf before-failure; exit 7" })),
    );
    expect(error.message).toContain("before-failure");
    expect(error.message).toContain("Command exited with code 7");
  });

  it("propagates outer cancellation into a real bash process", async () => {
    const cwd = newCwd();
    const outer = new AbortController();
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-bash-abort",
      signal: outer.signal,
    });
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setInterval(() => {}, 1000)",
    )}`;
    const pending = Effect.runPromise(Effect.flip(dispatch("bash", { command })));
    setTimeout(() => outer.abort(), 50);
    const error = await pending;
    expect(error.message).toContain("Command aborted");
  });

  it("refuses an edit whose old text does not match", async () => {
    const cwd = newCwd();
    const target = join(cwd, "edit.txt");
    writeFileSync(target, "original\n");
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-edit-refusal",
      signal: undefined,
    });
    const error = await Effect.runPromise(
      Effect.flip(
        dispatch("edit", {
          path: target,
          edits: [{ oldText: "missing", newText: "replacement" }],
        }),
      ),
    );
    expect(error.message).toContain("Could not find the exact text");
    expect(readFileSync(target, "utf8")).toBe("original\n");
  });

  it("refuses image files read through the real read tool", async () => {
    const cwd = newCwd();
    writeFileSync(join(cwd, "pixel.png"), PNG_BYTES);
    const dispatch = makeNestedPiToolDispatch({
      definitions: makeNestedPiToolDefinitions(cwd),
      ctx,
      toolCallId: "call-3",
      signal: undefined,
    });
    const error = await Effect.runPromise(
      Effect.flip(dispatch("read", { path: join(cwd, "pixel.png") })),
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("image");
  });

  it("hands nested tools a signal composed from the outer signal", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const definitions = nestedToolDefinitionsFixture({
      read: {
        execute: <Input>(_id: string, _input: Input, signal?: AbortSignal) => {
          seen.push(signal);
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("nested call aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("nested call aborted")), {
              once: true,
            });
          });
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
    const pending = Effect.runPromise(Effect.flip(dispatch("read", { path: "x" })));
    // Abort the *outer* execute signal; the nested tool observes it through composition.
    outer.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.message).toContain("nested call aborted");
    expect(seen[0]?.aborted).toBe(true);
  });
});
