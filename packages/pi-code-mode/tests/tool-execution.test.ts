// End-to-end `code_mode` execution through the real vendored runtime: exact guest catalog,
// real filesystem adapters, host limits, composed cancellation, progress, and diagnostics.
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach } from "vitest";
import { CodeMode } from "../src/boundary/codemode-runtime.ts";
import {
  makeNestedPiToolDefinitions,
  type NestedPiToolDefinitions,
  type PiGuestToolInput,
  type PiGuestToolName,
} from "../src/boundary/host-builtin-tools.ts";
import { DEFAULT_CODE_MODE_CONFIG, type CodeModeConfig } from "../src/config/schema.ts";
import type { CodeModeState } from "../src/config/store.ts";
import {
  CODE_MODE_UNAVAILABLE_MESSAGE,
  makeCodeModeToolExecute,
  type CodeModeExecutionEnvironment,
} from "../src/tools/execution.ts";
import { MAX_PROGRESS_ENTRIES, type CodeModeToolDetails } from "../src/tools/format.ts";
import { utf8ByteLength } from "../src/tools/limits.ts";
import { extensionContextFixture } from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } = nodeFsModule;
const { basename, join } = nodePathModule;

// JSON here quotes fixture values into guest program source and decodes guest results;
// these are code fixtures under test control, not schema boundaries.
const quote = (value: string): string => JSON.stringify(value);
const prettyJson = <A>(value: A): string => JSON.stringify(value, null, 2);
const guestJson = (text: string) => JSON.parse(text);

class NestedCallAbortedError extends Schema.TaggedError<NestedCallAbortedError>()(
  "NestedCallAbortedError",
  { message: Schema.String },
) {}

/** A promise handle whose settlement the test controls explicitly. */
const deferred = <A>() => {
  const gate = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(gate)),
    resolve: (value: A) => void Deferred.doneUnsafe(gate, Effect.succeed(value)),
  };
};

/** A promise that never resolves and rejects with "aborted" once `signal` aborts. */
const rejectOnAbort = (signal: AbortSignal | undefined, onStart?: () => void): Promise<never> => {
  onStart?.();
  const gate = Deferred.makeUnsafe<never, NestedCallAbortedError>();
  const rejectAborted = () =>
    void Deferred.doneUnsafe(gate, Effect.fail(new NestedCallAbortedError({ message: "aborted" })));
  if (signal?.aborted) rejectAborted();
  else signal?.addEventListener("abort", rejectAborted, { once: true });
  return Effect.runPromise(Deferred.await(gate));
};

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const newCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-exec-"));
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

const makeState = (overrides: Partial<CodeModeConfig> = {}, available = true): CodeModeState => {
  const config: CodeModeConfig = { ...DEFAULT_CODE_MODE_CONFIG, ...overrides };
  return {
    projectTrusted: true,
    available,
    config,
    provenance: {
      enabled: "default",
      timeoutMs: "default",
      maxToolCalls: "default",
      maxOutputBytes: "default",
      maxSourceBytes: "default",
      maxCumulativeChildOutputBytes: "default",
      catalogBudget: "default",
    },
    globalValues: {},
    projectValues: {},
    diagnostics: [],
    globalConfigPath: "/tmp/global.json",
    projectConfigPath: "/tmp/project.json",
  };
};

/**
 * Real built-in definitions with one deviation: `find` gets a plain-filesystem glob
 * operation so tests never depend on downloading the `fd` binary.
 */
const testDefinitions = (cwd: string): NestedPiToolDefinitions => {
  const real = makeNestedPiToolDefinitions(cwd);
  return real;
};

interface FakeCall {
  readonly name: string;
  readonly input: PiGuestToolInput;
  readonly signal: AbortSignal | undefined;
}

const fakeDefinitions = (
  impl: Partial<
    Record<
      PiGuestToolName,
      (input: PiGuestToolInput, signal: AbortSignal | undefined) => Promise<string>
    >
  >,
  calls?: FakeCall[],
): NestedPiToolDefinitions => {
  const definition = (name: PiGuestToolName) => ({
    execute: (_id: string, input: PiGuestToolInput, signal?: AbortSignal) => {
      calls?.push({ name, input, signal });
      const handler = impl[name];
      if (handler === undefined) {
        return Promise.reject(new Error(`fake ${name} is not implemented`));
      }
      return handler(input, signal).then((text) => ({
        content: [{ type: "text", text }],
        details: undefined,
      }));
    },
  });
  return nestedToolDefinitionsFixture({
    read: definition("read"),
    bash: definition("bash"),
    edit: definition("edit"),
    write: definition("write"),
    grep: definition("grep"),
    find: definition("find"),
    ls: definition("ls"),
  });
};

interface HarnessOptions {
  readonly config?: Partial<CodeModeConfig>;
  readonly available?: boolean;
  /** Simulates the no-current-state gate: getState() returns undefined. */
  readonly noState?: boolean;
  readonly definitions?: NestedPiToolDefinitions;
  readonly executeCodeMode?: CodeModeExecutionEnvironment["executeCodeMode"];
  readonly isCurrent?: () => boolean;
  readonly runInSession?: CodeModeExecutionEnvironment["runInSession"];
  readonly retainFailureDetails?: CodeModeExecutionEnvironment["retainFailureDetails"];
}

const makeHarness = (cwd: string, options: HarnessOptions = {}) => {
  const state = makeState(options.config ?? {}, options.available ?? true);
  const base = {
    isCurrent: options.isCurrent ?? (() => true),
    getState: () => (options.noState === true ? undefined : state),
    runInSession:
      options.runInSession ??
      ((effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined)),
    definitions: options.definitions ?? testDefinitions(cwd),
  };
  const execute =
    options.executeCodeMode === undefined
      ? base
      : { ...base, executeCodeMode: options.executeCodeMode };
  const environment =
    options.retainFailureDetails === undefined
      ? execute
      : { ...execute, retainFailureDetails: options.retainFailureDetails };
  return makeCodeModeToolExecute(environment);
};

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

describe("guest catalog", () => {
  it.effect("validates canonical non-empty edit input before dispatch", () =>
    Effect.gen(function* () {
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions({ edit: () => Promise.resolve("should not run") }, calls);
      const execute = makeHarness(newCwd(), { definitions });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-empty-edit",
            { code: "return await tools.pi.edit({ path: 'x', edits: [] });" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/\[InvalidToolInput\]/),
      );
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("searches the catalog through the runtime-owned $codemode.search", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd());
      const result = yield* Effect.promise(() =>
        execute(
          "call-search",
          {
            code:
              "const found = await tools.$codemode.search({ query: 'read' });\n" +
              "return found.items.map((item) => item.path);",
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toContain("tools.pi.read");
    }),
  );
});

describe("real nested tools", () => {
  it.effect("orchestrates parallel absolute-path reads and returns only derived data", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const other = newCwd();
      writeFileSync(join(cwd, "alpha.txt"), "alpha-content\n");
      writeFileSync(join(other, "beta.txt"), "beta-content\n");
      const execute = makeHarness(cwd);
      const program = `
      const paths = [${quote(join(cwd, "alpha.txt"))}, ${quote(join(other, "beta.txt"))}];
      const started = paths.map((path) => tools.pi.read({ path }));
      const bodies = [];
      for (const pending of started) bodies.push(await pending);
      return bodies.map((body) => body.includes("content")).join(",");
    `;
      const result = yield* Effect.promise(() =>
        execute("call-read", { code: program }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toBe("true,true");
    }),
  );

  it.effect("greps real files through the ripgrep-backed built-in", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      writeFileSync(join(cwd, "one.txt"), "needle here\nnothing\n");
      writeFileSync(join(cwd, "two.txt"), "nothing\n");
      const execute = makeHarness(cwd);
      const result = yield* Effect.promise(() =>
        execute(
          "call-grep",
          {
            code: `const out = await tools.pi.grep({ pattern: "needle", path: ${quote(cwd)} }); return out;`,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toContain("one.txt");
      expect(textOf(result)).not.toContain("two.txt");
    }),
  );

  it.effect("lists directories through the built-in ls", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      writeFileSync(join(cwd, "listed.txt"), "x");
      const execute = makeHarness(cwd);
      const result = yield* Effect.promise(() =>
        execute(
          "call-ls",
          { code: `return await tools.pi.ls({ path: ${quote(cwd)} });` },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toContain("listed.txt");
    }),
  );

  it.effect("applies the outer runtime timeout to a real nested bash process", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const execute = makeHarness(cwd, { config: { timeoutMs: 100 } });
      const command = `${quote(process.execPath)} -e ${quote("setInterval(() => {}, 1000)")}`;
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-real-bash-timeout",
            { code: `return await tools.pi.bash({ command: ${quote(command)} });` },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/\[TimeoutExceeded\].*100ms/s),
      );
    }),
  );

  it.effect("writes, reads, edits, and greps through the mutating built-ins", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const target = join(cwd, "nested", "created.txt");
      const execute = makeHarness(cwd);
      const result = yield* Effect.promise(() =>
        execute(
          "call-mutate",
          {
            code: `
          await tools.pi.write({ path: ${quote(target)}, content: "before\\n" });
          const first = await tools.pi.read({ path: ${quote(target)} });
          await tools.pi.edit({
            path: ${quote(target)},
            edits: [{ oldText: "before", newText: "after" }]
          });
          const hits = await tools.pi.grep({ pattern: "after", path: ${quote(target)} });
          return { wrote: first.includes("before"), edited: hits.includes("after") };
        `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(guestJson(textOf(result))).toEqual({ wrote: true, edited: true });
    }),
  );

  it.effect("finds files through the real find tool with filesystem glob operations", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      writeFileSync(join(cwd, "match-me.txt"), "x");
      writeFileSync(join(cwd, "skip.md"), "x");
      const { createFindToolDefinition } = yield* Effect.promise(
        () => import("@earendil-works/pi-coding-agent"),
      );
      const definitions = {
        ...makeNestedPiToolDefinitions(cwd),
        find: createFindToolDefinition(cwd, {
          operations: {
            exists: (path) => statSync(path, { throwIfNoEntry: false }) !== undefined,
            glob: (pattern, searchPath) =>
              readdirSync(searchPath).filter((name) =>
                new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(
                  basename(name),
                ),
              ),
          },
        }),
      };
      const execute = makeHarness(cwd, { definitions });
      const result = yield* Effect.promise(() =>
        execute(
          "call-find",
          { code: `return await tools.pi.find({ pattern: "*.txt", path: ${quote(cwd)} });` },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toContain("match-me.txt");
      expect(textOf(result)).not.toContain("skip.md");
    }),
  );
});

describe("availability and staleness gating", () => {
  it.effect("refuses when the registration is no longer current", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { isCurrent: () => false });
      yield* Effect.promise(() =>
        expect(
          execute("call-stale", { code: "return 1;" }, undefined, undefined, ctx),
        ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
    }),
  );

  it.effect("refuses when no current state exists at all", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { noState: true });
      yield* Effect.promise(() =>
        expect(
          execute("call-no-state", { code: "return 1;" }, undefined, undefined, ctx),
        ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
    }),
  );

  it.effect("refuses when availability was revoked after registration", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { available: false });
      yield* Effect.promise(() =>
        expect(
          execute("call-disabled", { code: "return 1;" }, undefined, undefined, ctx),
        ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
    }),
  );
});

describe("host limits", () => {
  it.effect("accepts program source at exactly maxSourceBytes and refuses one byte over", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const base = "return 'ok';//";
      const exact = base + "é".repeat((256 - utf8ByteLength(base)) / 2);
      expect(utf8ByteLength(exact)).toBe(256);
      const execute = makeHarness(cwd, { config: { maxSourceBytes: 256 } });
      const result = yield* Effect.promise(() =>
        execute("call-source", { code: exact }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toBe("ok");
      yield* Effect.promise(() =>
        expect(
          execute("call-source-over", { code: `${exact}a` }, undefined, undefined, ctx),
        ).rejects.toThrow(/257 UTF-8 bytes.*maxSourceBytes limit of 256/s),
      );
    }),
  );

  it.effect("records exact extension-only output kind without changing model-visible text", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd());
      const textResult = yield* Effect.promise(() =>
        execute(
          "call-text-kind",
          { code: String.raw`return '{"status":"one\\ntwo"}';` },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(textResult)).toBe('{"status":"one\\ntwo"}');
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((textResult.details as CodeModeToolDetails).outputKind).toBe("text");

      const structuredResult = yield* Effect.promise(() =>
        execute(
          "call-structured-kind",
          { code: `return { status: "one\\ntwo" };` },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(structuredResult)).toBe(prettyJson({ status: "one\ntwo" }));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((structuredResult.details as CodeModeToolDetails).outputKind).toBe("structured");
    }),
  );

  it.effect("applies maxToolCalls exactly", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({ read: () => Promise.resolve("data") });
      const execute = makeHarness(cwd, { config: { maxToolCalls: 1 }, definitions });
      const program =
        "await tools.pi.read({ path: 'a' });\n" +
        "await tools.pi.read({ path: 'b' });\n" +
        "return 'unreachable';";
      yield* Effect.promise(() =>
        expect(
          execute("call-toolcalls", { code: program }, undefined, undefined, ctx),
        ).rejects.toThrow(/\[ToolCallLimitExceeded\].*limit of 1/s),
      );
    }),
  );

  it.effect("applies timeoutMs as the runtime deadline and aborts in-flight nested calls", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions(
        { read: (_input, signal) => rejectOnAbort(signal) },
        calls,
      );
      const execute = makeHarness(cwd, { config: { timeoutMs: 50 }, definitions });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-timeout",
            { code: "return await tools.pi.read({ path: 'hang' });" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/\[TimeoutExceeded\].*50ms/s),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.signal?.aborted).toBe(true);
    }),
  );

  it.effect("keeps the runtime maxOutputBytes as the final outer output limit", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      // A budget large enough that the runtime's in-budget truncation marker fits.
      const execute = makeHarness(cwd, { config: { maxOutputBytes: 256 } });
      const result = yield* Effect.promise(() =>
        execute("call-output", { code: "return 'x'.repeat(4000);" }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toContain("[result truncated");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).truncated).toBe(true);
      expect(utf8ByteLength(textOf(result))).toBeLessThanOrEqual(256);
    }),
  );
});

describe("final model-visible byte bound", () => {
  const bytesOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): number =>
    utf8ByteLength(textOf(result));

  it.effect("clamps a zero budget to empty model-visible text", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 0 } });
      const result = yield* Effect.promise(() =>
        execute("call-zero", { code: "return 'anything';" }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toBe("");
    }),
  );

  it.effect("passes comfortably-fitting output through unchanged and bounds oversized output", () =>
    Effect.gen(function* () {
      // A budget well above the JSON-serialized value keeps the model-visible string intact.
      const fitExecute = makeHarness(newCwd(), { config: { maxOutputBytes: 64 } });
      const fit = yield* Effect.promise(() =>
        fitExecute("call-fit", { code: "return 'abcde';" }, undefined, undefined, ctx),
      );
      expect(textOf(fit)).toBe("abcde");

      const overExecute = makeHarness(newCwd(), { config: { maxOutputBytes: 24 } });
      const over = yield* Effect.promise(() =>
        overExecute(
          "call-over",
          { code: "return 'abcdef'.repeat(100);" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(bytesOf(over)).toBeLessThanOrEqual(24);
    }),
  );

  it.effect("bounds success output including appended logs inside the budget", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 48 } });
      const result = yield* Effect.promise(() =>
        execute(
          "call-logs-bound",
          {
            code: "console.log('a log line that is fairly long'); return 'result value here';",
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(bytesOf(result)).toBeLessThanOrEqual(48);
    }),
  );

  it.effect("never splits a multibyte code point in the clamped success output", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 21 } });
      const result = yield* Effect.promise(() =>
        execute(
          "call-multibyte-clamp",
          { code: "return 'é'.repeat(1000);" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(bytesOf(result)).toBeLessThanOrEqual(21);
      expect(textOf(result)).not.toContain("�");
    }),
  );

  it.effect("bounds a diagnostic failure with location and suggestions inside the budget", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 40 } });
      // An unsupported-syntax failure carries kind, location, and suggestions framing.
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-diag-bound",
            { code: "class Oops {}\nreturn 1;" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toSatisfy((error) => {
          const message = error instanceof Error ? error.message : String(error);
          return utf8ByteLength(message) <= 40;
        }),
      );
    }),
  );

  it.effect("bounds a hostile 100KB thrown string inside the budget without leaking it", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 128 } });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-hostile-throw",
            { code: "throw 'E'.repeat(100000);" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toSatisfy((error) => {
          const message = error instanceof Error ? error.message : String(error);
          return utf8ByteLength(message) <= 128 && !message.includes("E".repeat(1000));
        }),
      );
    }),
  );
});

describe("early-path model-visible byte bound", () => {
  it.effect(
    "clamps the cancellation text on the pre-abort path (zero, tiny, exact, multibyte)",
    () =>
      Effect.gen(function* () {
        const cwd = newCwd();
        const cancelledVia = (maxOutputBytes: number): Promise<string> => {
          const execute = makeHarness(cwd, { config: { maxOutputBytes } });
          const controller = new AbortController();
          controller.abort();
          return execute(
            `call-preabort-${maxOutputBytes}`,
            { code: "return 1;" },
            controller.signal,
            undefined,
            ctx,
          ).then((result) => {
            // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
            expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
            return textOf(result);
          });
        };
        expect(yield* Effect.promise(() => cancelledVia(0))).toBe("");
        const tiny = yield* Effect.promise(() => cancelledVia(8));
        expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(8);
        // Exact fit is admitted unchanged.
        const exact = yield* Effect.promise(() =>
          cancelledVia(utf8ByteLength("Execution cancelled.")),
        );
        expect(exact).toBe("Execution cancelled.");
      }),
  );

  it.live("clamps the cancellation text after a mid-run abort", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({
        read: (_input, signal) => rejectOnAbort(signal),
      });
      const execute = makeHarness(cwd, { definitions, config: { maxOutputBytes: 0 } });
      const controller = new AbortController();
      const pending = execute(
        "call-abort-zero",
        { code: "return await tools.pi.read({ path: 'hang' });" },
        controller.signal,
        undefined,
        ctx,
      );
      yield* Effect.sleep(20);
      controller.abort();
      const result = yield* Effect.promise(() => pending);
      expect(textOf(result)).toBe("");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
    }),
  );

  it.effect("clamps the source-size refusal (zero, tiny, multibyte-safe)", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const oversized = "é".repeat(300); // 600 UTF-8 bytes
      const messageFor = (maxOutputBytes: number): Promise<string> => {
        const execute = makeHarness(cwd, {
          config: { maxSourceBytes: 16, maxOutputBytes },
        });
        return execute(
          `call-src-${maxOutputBytes}`,
          { code: oversized },
          undefined,
          undefined,
          ctx,
        ).then(
          () => {
            throw new Error("expected a source-size refusal");
          },
          (error) => (error instanceof Error ? error.message : String(error)),
        );
      };
      expect(yield* Effect.promise(() => messageFor(0))).toBe("");
      const tiny = yield* Effect.promise(() => messageFor(24));
      expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(24);
      expect(tiny).not.toContain("�");
      const generous = yield* Effect.promise(() => messageFor(4096));
      expect(generous).toContain("maxSourceBytes limit of 16");
    }),
  );

  it.effect("clamps the unexpected-runtime-error message before the Error is constructed", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const hostile = "H".repeat(100_000);
      const messageFor = (maxOutputBytes: number): Promise<string> => {
        const execute = makeHarness(cwd, {
          config: { maxOutputBytes },
          // Neither aborted nor stale: this is the unexpected-error branch.
          runInSession: () => Promise.reject(new Error(hostile)),
        });
        return execute(
          `call-unexpected-${maxOutputBytes}`,
          { code: "return 1;" },
          undefined,
          undefined,
          ctx,
        ).then(
          () => {
            throw new Error("expected an unexpected-error refusal");
          },
          (error) => (error instanceof Error ? error.message : String(error)),
        );
      };
      expect(yield* Effect.promise(() => messageFor(0))).toBe("");
      const bounded = yield* Effect.promise(() => messageFor(128));
      expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(128);
      expect(bounded).toContain("code_mode execution did not complete");
      expect(bounded).not.toContain("H".repeat(1_000));
    }),
  );

  it.effect(
    "keeps the stale/no-state refusal a short fixed message when no config can clamp it",
    () =>
      Effect.gen(function* () {
        // Only the gates with no current configuration (stale registration, missing state) use
        // the fixed bounded constant; there is no maxOutputBytes to clamp against there.
        const cwd = newCwd();
        for (const options of [{ noState: true }, { isCurrent: () => false }]) {
          const execute = makeHarness(cwd, { ...options, config: { maxOutputBytes: 0 } });
          yield* Effect.promise(() =>
            expect(
              execute("call-unavailable-fixed", { code: "return 1;" }, undefined, undefined, ctx),
            ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
          );
        }
        expect(utf8ByteLength(CODE_MODE_UNAVAILABLE_MESSAGE)).toBeLessThan(512);
      }),
  );

  it.effect(
    "clamps the current-but-unavailable refusal through the configured maxOutputBytes",
    () =>
      Effect.gen(function* () {
        // A disabled/untrusted session still has a current configuration, so even its refusal
        // obeys the configured clamp instead of a fixed unclamped constant.
        const cwd = newCwd();
        const messageFor = (maxOutputBytes: number): Promise<string> => {
          const execute = makeHarness(cwd, { available: false, config: { maxOutputBytes } });
          return execute(
            `call-unavailable-clamped-${maxOutputBytes}`,
            { code: "return 1;" },
            undefined,
            undefined,
            ctx,
          ).then(
            () => {
              throw new Error("expected an unavailable refusal");
            },
            (error) => (error instanceof Error ? error.message : String(error)),
          );
        };
        // Zero budget: the refusal is empty - nothing model-visible leaks past the clamp.
        expect(yield* Effect.promise(() => messageFor(0))).toBe("");
        // Tiny budget: truncated within the byte budget.
        const tiny = yield* Effect.promise(() => messageFor(16));
        expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(16);
        expect(CODE_MODE_UNAVAILABLE_MESSAGE.startsWith(tiny)).toBe(true);
        // Exact budget: an exact fit passes through unchanged (the message is pure ASCII, so
        // byte length equals character length and no multibyte boundary can be split).
        const exactBudget = utf8ByteLength(CODE_MODE_UNAVAILABLE_MESSAGE);
        expect(yield* Effect.promise(() => messageFor(exactBudget))).toBe(
          CODE_MODE_UNAVAILABLE_MESSAGE,
        );
        // One byte under: still clamped inside the budget.
        const under = yield* Effect.promise(() => messageFor(exactBudget - 1));
        expect(utf8ByteLength(under)).toBeLessThanOrEqual(exactBudget - 1);
        expect(under).not.toBe(CODE_MODE_UNAVAILABLE_MESSAGE);
      }),
  );
});

describe("cumulative nested output budget", () => {
  it.effect("admits an exact cumulative fit and refuses the first overrun model-safely", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({ read: () => Promise.resolve("12345678") });
      const exactExecute = makeHarness(cwd, {
        config: { maxCumulativeChildOutputBytes: 16 },
        definitions,
      });
      const program =
        "const one = await tools.pi.read({ path: 'a' });\n" +
        "const two = await tools.pi.read({ path: 'b' });\n" +
        "return one + two;";
      const exact = yield* Effect.promise(() =>
        exactExecute("call-budget", { code: program }, undefined, undefined, ctx),
      );
      expect(textOf(exact)).toBe("1234567812345678");

      const overExecute = makeHarness(cwd, {
        config: { maxCumulativeChildOutputBytes: 15 },
        definitions,
      });
      yield* Effect.promise(() =>
        expect(
          overExecute("call-budget-over", { code: program }, undefined, undefined, ctx),
        ).rejects.toThrow(/\[ToolFailure\].*cumulative nested-output budget.*8 of 15 bytes/s),
      );
    }),
  );

  it.effect("counts multibyte guest data in exact UTF-8 bytes", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      // 4 characters, 8 UTF-8 bytes.
      const definitions = fakeDefinitions({ read: () => Promise.resolve("éééé") });
      const execute = makeHarness(cwd, {
        config: { maxCumulativeChildOutputBytes: 8 },
        definitions,
      });
      const fits = yield* Effect.promise(() =>
        execute(
          "call-multibyte",
          { code: "return await tools.pi.read({ path: 'a' });" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(fits)).toBe("éééé");

      const refusing = makeHarness(cwd, {
        config: { maxCumulativeChildOutputBytes: 7 },
        definitions,
      });
      yield* Effect.promise(() =>
        expect(
          refusing(
            "call-multibyte-over",
            { code: "return await tools.pi.read({ path: 'a' });" },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/cumulative nested-output budget/),
      );
    }),
  );

  it.effect("stays exact under parallel nested calls at the fixed runtime concurrency", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      // Five parallel 4-byte results against a 12-byte budget: exactly three are admitted no
      // matter how the parallel calls settle; the two refusals surface as catchable errors.
      const definitions = fakeDefinitions({ read: () => Promise.resolve("DATA") });
      const execute = makeHarness(cwd, {
        config: { maxCumulativeChildOutputBytes: 12 },
        definitions,
      });
      const program = `
      const names = ["a", "b", "c", "d", "e"];
      const started = names.map((name) => tools.pi.read({ path: name }));
      let admitted = 0;
      let refused = 0;
      for (const pending of started) {
        try {
          await pending;
          admitted = admitted + 1;
        } catch (error) {
          refused = refused + 1;
        }
      }
      return { admitted, refused };
    `;
      const result = yield* Effect.promise(() =>
        execute("call-parallel", { code: program }, undefined, undefined, ctx),
      );
      expect(guestJson(textOf(result))).toEqual({ admitted: 3, refused: 2 });
    }),
  );
});

describe("cancellation", () => {
  it.effect("returns a cancelled result for a pre-aborted signal without executing anything", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const calls: FakeCall[] = [];
      const definitions = fakeDefinitions({ read: () => Promise.resolve("data") }, calls);
      const execute = makeHarness(cwd, { definitions });
      const controller = new AbortController();
      controller.abort();
      const result = yield* Effect.promise(() =>
        execute(
          "call-preaborted",
          { code: "return await tools.pi.read({ path: 'a' });" },
          controller.signal,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toBe("Execution cancelled.");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("aborts mid-flight executions and their nested calls through the outer signal", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const calls: FakeCall[] = [];
      const started = deferred<void>();
      const definitions = fakeDefinitions(
        { read: (_input, signal) => rejectOnAbort(signal, () => started.resolve()) },
        calls,
      );
      const execute = makeHarness(cwd, { definitions });
      const controller = new AbortController();
      const pending = execute(
        "call-abort",
        { code: "return await tools.pi.read({ path: 'hang' });" },
        controller.signal,
        undefined,
        ctx,
      );
      yield* Effect.promise(() => started.promise);
      controller.abort();
      const result = yield* Effect.promise(() => pending);
      expect(textOf(result)).toBe("Execution cancelled.");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
      expect(calls[0]?.signal?.aborted).toBe(true);
    }),
  );

  it.live("settles as cancelled when the session runtime is replaced or shut down mid-run", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      let current = true;
      const disposal = new AbortController();
      const definitions = fakeDefinitions({
        read: (_input, signal) => rejectOnAbort(signal),
      });
      const execute = makeHarness(cwd, {
        definitions,
        isCurrent: () => current,
        // The managed session runtime interrupts running fibers on disposal; the disposal
        // controller stands in for that interruption here.
        runInSession: (effect, signal) =>
          runPromise(
            effect,
            signal
              ? { signal: AbortSignal.any([signal, disposal.signal]) }
              : { signal: disposal.signal },
          ),
      });
      const pending = execute(
        "call-replaced",
        { code: "return await tools.pi.read({ path: 'hang' });" },
        undefined,
        undefined,
        ctx,
      );
      yield* Effect.sleep(20);
      current = false;
      disposal.abort();
      const result = yield* Effect.promise(() => pending);
      expect(textOf(result)).toBe("Execution cancelled.");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
    }),
  );
});

describe("progress", () => {
  it.effect("keeps tracked rows bounded while preserving exact counts above 256 calls", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({ read: () => Promise.resolve("ok") });
      const execute = makeHarness(cwd, {
        definitions,
        config: { maxToolCalls: 300 },
      });
      const result = yield* Effect.promise(() =>
        execute(
          "call-many-progress",
          {
            code: `
          const pending = [];
          for (let index = 0; index < 300; index += 1) {
            pending.push(tools.pi.read({ path: "same" }));
          }
          const values = await Promise.all(pending);
          return values.length;
        `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(result.details.counts).toMatchObject({
        total: 300,
        succeeded: 300,
        failed: 0,
        queued: 0,
        running: 0,
      });
      expect(result.details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    }),
  );

  it.live("starts immediately, frame-coalesces fast calls, and stops after settle", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const secret = "SECRET-NESTED-OUTPUT";
      const definitions = fakeDefinitions({ read: () => Promise.resolve(secret) });
      const execute = makeHarness(cwd, { definitions });
      const updates: Array<{ text: string; details: CodeModeToolDetails }> = [];
      const result = yield* Effect.promise(() =>
        execute(
          "call-progress",
          { code: "return await tools.pi.read({ path: 'a' });" },
          undefined,
          (partial) => {
            updates.push({ text: textOf(partial), details: partial.details });
          },
          ctx,
        ),
      );
      expect(textOf(result)).toBe(secret);
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(updates[0]).toMatchObject({
        text: "code_mode: starting",
        details: { toolCalls: [] },
      });
      const callUpdates = updates.slice(1);
      for (const update of callUpdates) {
        expect(update.text).not.toContain(secret);
        expect(update.text).toContain("pi.read");
        expect(update.details.toolCalls[0]?.tool).toBe("pi.read");
      }
      // Admission and the enriched running row bypass extension-side frame coalescing so Pi can
      // include them in its own already-scheduled frame; settlement still flushes the final state.
      expect(callUpdates[0]?.details.toolCalls[0]?.status).toBe("queued");
      expect(callUpdates.some((update) => update.details.toolCalls[0]?.status === "running")).toBe(
        true,
      );
      expect(callUpdates.at(-1)?.details.toolCalls[0]?.status).toBe("completed");
      const updateCountAtSettle = updates.length;
      yield* Effect.sleep(25);
      expect(updates.length).toBe(updateCountAtSettle);
    }),
  );

  it.live("publishes a running snapshot when a nested call spans a host render frame", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const release = deferred<string>();
      const definitions = fakeDefinitions({
        read: () => release.promise,
      });
      const execute = makeHarness(cwd, { definitions });
      const updates: CodeModeToolDetails[] = [];
      const pending = execute(
        "call-progress-frame",
        { code: "return await tools.pi.read({ path: 'slow.txt' });" },
        undefined,
        (partial) => updates.push(partial.details),
        ctx,
      );
      while (!updates.some((details) => details.toolCalls[0]?.status === "running")) {
        yield* Effect.sleep(1);
      }
      release.resolve("slow-data");
      const result = yield* Effect.promise(() => pending);

      expect(textOf(result)).toBe("slow-data");
      expect(updates[0]?.toolCalls).toEqual([]);
      expect(updates.some((details) => details.toolCalls[0]?.status === "running")).toBe(true);
      expect(updates.at(-1)?.toolCalls[0]?.status).toBe("completed");
    }),
  );

  it.effect(
    "falls back to legacy start/end hooks when a reload-cached runtime emits no lifecycle events",
    () =>
      Effect.gen(function* () {
        const cwd = newCwd();
        const definitions = fakeDefinitions({ read: () => Promise.resolve("legacy-data") });
        const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
          options,
        ) => {
          const { onToolCallLifecycle: _ignored, ...legacyOptions } = options;
          return CodeMode.execute(legacyOptions);
        };
        const execute = makeHarness(cwd, { definitions, executeCodeMode });
        const result = yield* Effect.promise(() =>
          execute(
            "call-legacy-runtime",
            { code: "return await tools.pi.read({ path: 'legacy.txt' });" },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(textOf(result)).toBe("legacy-data");
        expect(result.details.counts).toMatchObject({ total: 1, succeeded: 1 });
        expect(result.details.toolCalls).toEqual([
          expect.objectContaining({
            tool: "pi.read",
            status: "completed",
            activity: "Read legacy.txt",
          }),
        ]);
      }),
  );

  it.effect(
    "accepts an optional intent and records bounded activity labels from decoded input",
    () =>
      Effect.gen(function* () {
        const cwd = newCwd();
        const definitions = fakeDefinitions({
          read: () => Promise.resolve("data"),
          grep: () => Promise.resolve("hits"),
        });
        const execute = makeHarness(cwd, { definitions });
        const withIntent = yield* Effect.promise(() =>
          execute(
            "call-intent",
            {
              code:
                "await tools.pi.read({ path: 'src/a.ts' });\n" +
                "return await tools.pi.grep({ pattern: 'TODO' });",
              intent: "Probe the repo",
            },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(textOf(withIntent)).toBe("hits");
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        const details = withIntent.details as CodeModeToolDetails;
        expect(details.toolCalls.map((call) => call.activity)).toEqual([
          "Read src/a.ts",
          "Search TODO in cwd",
        ]);
        // Intent never affects execution: the same program without it yields the same output.
        const withoutIntent = yield* Effect.promise(() =>
          execute(
            "call-no-intent",
            { code: "return await tools.pi.grep({ pattern: 'TODO' });" },
            undefined,
            undefined,
            ctx,
          ),
        );
        expect(textOf(withoutIntent)).toBe("hits");
      }),
  );

  it.live("survives hostile onUpdate callbacks: sync throws and rejecting thenables", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({ read: () => Promise.resolve("data") });
      const execute = makeHarness(cwd, { definitions });
      let invocations = 0;
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const result = yield* Effect.promise(() =>
        execute(
          "call-hostile",
          { code: "return await tools.pi.read({ path: 'a' });" },
          undefined,
          (() => {
            invocations += 1;
            if (invocations % 2 === 0) throw new Error("hostile sync throw");
            // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
            return Promise.reject(new Error("hostile rejection"));
          }) as never,
          ctx,
        ),
      );
      expect(textOf(result)).toBe("data");
      expect(invocations).toBeGreaterThanOrEqual(2);
      // A rejected thenable from the host is absorbed; give it a tick to surface if not.
      yield* Effect.sleep(10);
    }),
  );
});

describe("diagnostics and errors", () => {
  it.effect("reports parse errors with the normalized diagnostic kind", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd());
      yield* Effect.promise(() =>
        expect(
          execute("call-parse", { code: "return await (" }, undefined, undefined, ctx),
        ).rejects.toThrow(/\[ParseError\]/),
      );
    }),
  );

  it.effect("charges catchable nested failure text to the cumulative child-output budget", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const definitions = fakeDefinitions({
        bash: () => Promise.reject(new Error("failure-" + "x".repeat(1_000))),
      });
      const execute = makeHarness(cwd, {
        definitions,
        config: { maxCumulativeChildOutputBytes: 48 },
      });
      const result = yield* Effect.promise(() =>
        execute(
          "call-bounded-error",
          {
            code: `
          try {
            await tools.pi.bash({ command: "false" });
            return "unexpected";
          } catch (error) {
            return { message: error.message, length: error.message.length };
          }
        `,
          },
          undefined,
          undefined,
          ctx,
        ),
      );
      // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
      const observed = guestJson(textOf(result)) as { message: string; length: number };
      expect(observed.length).toBeLessThanOrEqual(48);
      expect(observed.message).toContain("Nested tool 'bash' failed");
      expect(observed.message).not.toContain("x".repeat(100));
    }),
  );

  it.effect("retains settled lifecycle details before an uncaught runtime failure is thrown", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const retained: Array<{ id: string; details: CodeModeToolDetails }> = [];
      const execute = makeHarness(cwd, {
        retainFailureDetails: (id, details) => retained.push({ id, details }),
      });
      yield* Effect.promise(() =>
        expect(
          execute(
            "call-retained-failure",
            { code: `return await tools.pi.read({ path: ${quote(join(cwd, "missing"))} });` },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow(/ToolFailure/),
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.id).toBe("call-retained-failure");
      expect(retained[0]?.details.toolCalls[0]?.status).toBe("error");
      expect(retained[0]?.details.counts).toMatchObject({ total: 1, failed: 1 });
    }),
  );

  it.effect("lets programs observe nested tool failures with try/catch", () =>
    Effect.gen(function* () {
      const cwd = newCwd();
      const execute = makeHarness(cwd);
      const program = `
      try {
        await tools.pi.read({ path: ${quote(join(cwd, "missing.txt"))} });
        return "unexpected";
      } catch (error) {
        return "caught: " + error.message;
      }
    `;
      const result = yield* Effect.promise(() =>
        execute("call-caught", { code: program }, undefined, undefined, ctx),
      );
      expect(textOf(result)).toContain("caught:");
      expect(textOf(result)).toContain("Nested tool 'read' failed");
    }),
  );

  it.effect("preserves console logs in the model-visible output", () =>
    Effect.gen(function* () {
      const execute = makeHarness(newCwd());
      const result = yield* Effect.promise(() =>
        execute(
          "call-logs",
          { code: "console.log('probe log'); return 'done';" },
          undefined,
          undefined,
          ctx,
        ),
      );
      expect(textOf(result)).toBe("done\n\nLogs:\nprobe log");
    }),
  );
});
