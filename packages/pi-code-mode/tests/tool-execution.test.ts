// End-to-end `code_mode` execution through the real vendored runtime: exact guest catalog,
// real filesystem adapters, host limits, composed cancellation, progress, and diagnostics.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { CodeMode } from "../src/boundary/codemode-runtime.ts";
import {
  makeNestedPiToolDefinitions,
  type NestedPiToolDefinitions,
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

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const newCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-exec-"));
  tempDirectories.push(cwd);
  return cwd;
};

const ctx = {
  cwd: "/",
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
} as unknown as ExtensionContext;

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
  readonly input: unknown;
  readonly signal: AbortSignal | undefined;
}

const fakeDefinitions = (
  impl: Partial<
    Record<PiGuestToolName, (input: unknown, signal: AbortSignal | undefined) => Promise<string>>
  >,
  calls?: FakeCall[],
): NestedPiToolDefinitions => {
  const definition = (name: PiGuestToolName) => ({
    execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
      calls?.push({ name, input, signal });
      const handler = impl[name];
      if (handler === undefined) throw new Error(`fake ${name} is not implemented`);
      const text = await handler(input, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
  return {
    read: definition("read"),
    bash: definition("bash"),
    edit: definition("edit"),
    write: definition("write"),
    grep: definition("grep"),
    find: definition("find"),
    ls: definition("ls"),
  } as unknown as NestedPiToolDefinitions;
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
  return makeCodeModeToolExecute({
    isCurrent: options.isCurrent ?? (() => true),
    getState: () => (options.noState === true ? undefined : state),
    runInSession:
      options.runInSession ??
      ((effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined)),
    definitions: options.definitions ?? testDefinitions(cwd),
    ...(options.executeCodeMode === undefined ? {} : { executeCodeMode: options.executeCodeMode }),
    ...(options.retainFailureDetails === undefined
      ? {}
      : { retainFailureDetails: options.retainFailureDetails }),
  });
};

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

describe("guest catalog", () => {
  it("exposes exactly all seven Pi built-ins plus runtime discovery", async () => {
    const execute = makeHarness(newCwd());
    const result = await execute(
      "call-catalog",
      { code: "return { top: Object.keys(tools), pi: Object.keys(tools.pi) };" },
      undefined,
      undefined,
      ctx,
    );
    const value = JSON.parse(textOf(result)) as { top: string[]; pi: string[] };
    expect([...value.top].sort()).toEqual(["$codemode", "pi"]);
    expect([...value.pi].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("keeps Pi built-ins namespaced and refuses guessed top-level paths", async () => {
    const execute = makeHarness(newCwd());
    const result = await execute(
      "call-bash",
      { code: "return await tools.pi.bash({ command: 'printf nested-bash' });" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toBe("nested-bash");
    await expect(
      execute(
        "call-forbidden",
        { code: "return await tools.bash({ command: 'true' });" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/\[UnknownTool\]/);
  });

  it("validates canonical non-empty edit input before dispatch", async () => {
    const calls: FakeCall[] = [];
    const definitions = fakeDefinitions({ edit: async () => "should not run" }, calls);
    const execute = makeHarness(newCwd(), { definitions });
    await expect(
      execute(
        "call-empty-edit",
        { code: "return await tools.pi.edit({ path: 'x', edits: [] });" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/\[InvalidToolInput\]/);
    expect(calls).toHaveLength(0);
  });

  it("searches the catalog through the runtime-owned $codemode.search", async () => {
    const execute = makeHarness(newCwd());
    const result = await execute(
      "call-search",
      {
        code:
          "const found = await tools.$codemode.search({ query: 'read' });\n" +
          "return found.items.map((item) => item.path);",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("tools.pi.read");
  });
});

describe("real nested tools", () => {
  it("orchestrates parallel absolute-path reads and returns only derived data", async () => {
    const cwd = newCwd();
    const other = newCwd();
    writeFileSync(join(cwd, "alpha.txt"), "alpha-content\n");
    writeFileSync(join(other, "beta.txt"), "beta-content\n");
    const execute = makeHarness(cwd);
    const program = `
      const paths = [${JSON.stringify(join(cwd, "alpha.txt"))}, ${JSON.stringify(join(other, "beta.txt"))}];
      const started = paths.map((path) => tools.pi.read({ path }));
      const bodies = [];
      for (const pending of started) bodies.push(await pending);
      return bodies.map((body) => body.includes("content")).join(",");
    `;
    const result = await execute("call-read", { code: program }, undefined, undefined, ctx);
    expect(textOf(result)).toBe("true,true");
  });

  it("greps real files through the ripgrep-backed built-in", async () => {
    const cwd = newCwd();
    writeFileSync(join(cwd, "one.txt"), "needle here\nnothing\n");
    writeFileSync(join(cwd, "two.txt"), "nothing\n");
    const execute = makeHarness(cwd);
    const result = await execute(
      "call-grep",
      {
        code: `const out = await tools.pi.grep({ pattern: "needle", path: ${JSON.stringify(cwd)} }); return out;`,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("one.txt");
    expect(textOf(result)).not.toContain("two.txt");
  });

  it("lists directories through the built-in ls", async () => {
    const cwd = newCwd();
    writeFileSync(join(cwd, "listed.txt"), "x");
    const execute = makeHarness(cwd);
    const result = await execute(
      "call-ls",
      { code: `return await tools.pi.ls({ path: ${JSON.stringify(cwd)} });` },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("listed.txt");
  });

  it("applies the outer runtime timeout to a real nested bash process", async () => {
    const cwd = newCwd();
    const execute = makeHarness(cwd, { config: { timeoutMs: 100 } });
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "setInterval(() => {}, 1000)",
    )}`;
    await expect(
      execute(
        "call-real-bash-timeout",
        { code: `return await tools.pi.bash({ command: ${JSON.stringify(command)} });` },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/\[TimeoutExceeded\].*100ms/s);
  });

  it("writes, reads, edits, and greps through the mutating built-ins", async () => {
    const cwd = newCwd();
    const target = join(cwd, "nested", "created.txt");
    const execute = makeHarness(cwd);
    const result = await execute(
      "call-mutate",
      {
        code: `
          await tools.pi.write({ path: ${JSON.stringify(target)}, content: "before\\n" });
          const first = await tools.pi.read({ path: ${JSON.stringify(target)} });
          await tools.pi.edit({
            path: ${JSON.stringify(target)},
            edits: [{ oldText: "before", newText: "after" }]
          });
          const hits = await tools.pi.grep({ pattern: "after", path: ${JSON.stringify(target)} });
          return { wrote: first.includes("before"), edited: hits.includes("after") };
        `,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(JSON.parse(textOf(result))).toEqual({ wrote: true, edited: true });
  });

  it("finds files through the real find tool with filesystem glob operations", async () => {
    const cwd = newCwd();
    writeFileSync(join(cwd, "match-me.txt"), "x");
    writeFileSync(join(cwd, "skip.md"), "x");
    const { createFindToolDefinition } = await import("@earendil-works/pi-coding-agent");
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
    const result = await execute(
      "call-find",
      { code: `return await tools.pi.find({ pattern: "*.txt", path: ${JSON.stringify(cwd)} });` },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("match-me.txt");
    expect(textOf(result)).not.toContain("skip.md");
  });
});

describe("availability and staleness gating", () => {
  it("refuses when the registration is no longer current", async () => {
    const execute = makeHarness(newCwd(), { isCurrent: () => false });
    await expect(
      execute("call-stale", { code: "return 1;" }, undefined, undefined, ctx),
    ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE);
  });

  it("refuses when no current state exists at all", async () => {
    const execute = makeHarness(newCwd(), { noState: true });
    await expect(
      execute("call-no-state", { code: "return 1;" }, undefined, undefined, ctx),
    ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE);
  });

  it("refuses when availability was revoked after registration", async () => {
    const execute = makeHarness(newCwd(), { available: false });
    await expect(
      execute("call-disabled", { code: "return 1;" }, undefined, undefined, ctx),
    ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE);
  });
});

describe("host limits", () => {
  it("accepts program source at exactly maxSourceBytes and refuses one byte over", async () => {
    const cwd = newCwd();
    const base = "return 'ok';//";
    const exact = base + "é".repeat((256 - utf8ByteLength(base)) / 2);
    expect(utf8ByteLength(exact)).toBe(256);
    const execute = makeHarness(cwd, { config: { maxSourceBytes: 256 } });
    const result = await execute("call-source", { code: exact }, undefined, undefined, ctx);
    expect(textOf(result)).toBe("ok");
    await expect(
      execute("call-source-over", { code: `${exact}a` }, undefined, undefined, ctx),
    ).rejects.toThrow(/257 UTF-8 bytes.*maxSourceBytes limit of 256/s);
  });

  it("applies maxToolCalls exactly", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "data" });
    const execute = makeHarness(cwd, { config: { maxToolCalls: 1 }, definitions });
    const program =
      "await tools.pi.read({ path: 'a' });\n" +
      "await tools.pi.read({ path: 'b' });\n" +
      "return 'unreachable';";
    await expect(
      execute("call-toolcalls", { code: program }, undefined, undefined, ctx),
    ).rejects.toThrow(/\[ToolCallLimitExceeded\].*limit of 1/s);
  });

  it("applies timeoutMs as the runtime deadline and aborts in-flight nested calls", async () => {
    const cwd = newCwd();
    const calls: FakeCall[] = [];
    const definitions = fakeDefinitions(
      {
        read: (_input, signal) =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error("aborted"));
            signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      },
      calls,
    );
    const execute = makeHarness(cwd, { config: { timeoutMs: 50 }, definitions });
    await expect(
      execute(
        "call-timeout",
        { code: "return await tools.pi.read({ path: 'hang' });" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/\[TimeoutExceeded\].*50ms/s);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("keeps the runtime maxOutputBytes as the final outer output limit", async () => {
    const cwd = newCwd();
    // A budget large enough that the runtime's in-budget truncation marker fits.
    const execute = makeHarness(cwd, { config: { maxOutputBytes: 256 } });
    const result = await execute(
      "call-output",
      { code: "return 'x'.repeat(4000);" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("[result truncated");
    expect((result.details as CodeModeToolDetails).truncated).toBe(true);
    expect(utf8ByteLength(textOf(result))).toBeLessThanOrEqual(256);
  });
});

describe("final model-visible byte bound", () => {
  const bytesOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): number =>
    utf8ByteLength(textOf(result));

  it("clamps a zero budget to empty model-visible text", async () => {
    const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 0 } });
    const result = await execute(
      "call-zero",
      { code: "return 'anything';" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toBe("");
  });

  it("passes comfortably-fitting output through unchanged and bounds oversized output", async () => {
    // A budget well above the JSON-serialized value keeps the model-visible string intact.
    const fitExecute = makeHarness(newCwd(), { config: { maxOutputBytes: 64 } });
    const fit = await fitExecute(
      "call-fit",
      { code: "return 'abcde';" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(fit)).toBe("abcde");

    const overExecute = makeHarness(newCwd(), { config: { maxOutputBytes: 24 } });
    const over = await overExecute(
      "call-over",
      { code: "return 'abcdef'.repeat(100);" },
      undefined,
      undefined,
      ctx,
    );
    expect(bytesOf(over)).toBeLessThanOrEqual(24);
  });

  it("bounds success output including appended logs inside the budget", async () => {
    const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 48 } });
    const result = await execute(
      "call-logs-bound",
      {
        code: "console.log('a log line that is fairly long'); return 'result value here';",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(bytesOf(result)).toBeLessThanOrEqual(48);
  });

  it("never splits a multibyte code point in the clamped success output", async () => {
    const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 21 } });
    const result = await execute(
      "call-multibyte-clamp",
      { code: "return 'é'.repeat(1000);" },
      undefined,
      undefined,
      ctx,
    );
    expect(bytesOf(result)).toBeLessThanOrEqual(21);
    expect(textOf(result)).not.toContain("�");
  });

  it("bounds a diagnostic failure with location and suggestions inside the budget", async () => {
    const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 40 } });
    // An unsupported-syntax failure carries kind, location, and suggestions framing.
    await expect(
      execute("call-diag-bound", { code: "class Oops {}\nreturn 1;" }, undefined, undefined, ctx),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return utf8ByteLength(message) <= 40;
    });
  });

  it("bounds a hostile 100KB thrown string inside the budget without leaking it", async () => {
    const execute = makeHarness(newCwd(), { config: { maxOutputBytes: 128 } });
    await expect(
      execute(
        "call-hostile-throw",
        { code: "throw 'E'.repeat(100000);" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return utf8ByteLength(message) <= 128 && !message.includes("E".repeat(1000));
    });
  });
});

describe("early-path model-visible byte bound", () => {
  it("clamps the cancellation text on the pre-abort path (zero, tiny, exact, multibyte)", async () => {
    const cwd = newCwd();
    const cancelledVia = async (maxOutputBytes: number): Promise<string> => {
      const execute = makeHarness(cwd, { config: { maxOutputBytes } });
      const controller = new AbortController();
      controller.abort();
      const result = await execute(
        `call-preabort-${maxOutputBytes}`,
        { code: "return 1;" },
        controller.signal,
        undefined,
        ctx,
      );
      expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
      return textOf(result);
    };
    expect(await cancelledVia(0)).toBe("");
    const tiny = await cancelledVia(8);
    expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(8);
    // Exact fit is admitted unchanged.
    const exact = await cancelledVia(utf8ByteLength("Execution cancelled."));
    expect(exact).toBe("Execution cancelled.");
  });

  it("clamps the cancellation text after a mid-run abort", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({
      read: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(textOf(result)).toBe("");
    expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
  });

  it("clamps the source-size refusal (zero, tiny, multibyte-safe)", async () => {
    const cwd = newCwd();
    const oversized = "é".repeat(300); // 600 UTF-8 bytes
    const messageFor = async (maxOutputBytes: number): Promise<string> => {
      const execute = makeHarness(cwd, {
        config: { maxSourceBytes: 16, maxOutputBytes },
      });
      try {
        await execute(`call-src-${maxOutputBytes}`, { code: oversized }, undefined, undefined, ctx);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected a source-size refusal");
    };
    expect(await messageFor(0)).toBe("");
    const tiny = await messageFor(24);
    expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(24);
    expect(tiny).not.toContain("�");
    const generous = await messageFor(4096);
    expect(generous).toContain("maxSourceBytes limit of 16");
  });

  it("clamps the unexpected-runtime-error message before the Error is constructed", async () => {
    const cwd = newCwd();
    const hostile = "H".repeat(100_000);
    const messageFor = async (maxOutputBytes: number): Promise<string> => {
      const execute = makeHarness(cwd, {
        config: { maxOutputBytes },
        // Neither aborted nor stale: this is the unexpected-error branch.
        runInSession: () => Promise.reject(new Error(hostile)),
      });
      try {
        await execute(
          `call-unexpected-${maxOutputBytes}`,
          { code: "return 1;" },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected an unexpected-error refusal");
    };
    expect(await messageFor(0)).toBe("");
    const bounded = await messageFor(128);
    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(128);
    expect(bounded).toContain("code_mode execution did not complete");
    expect(bounded).not.toContain("H".repeat(1_000));
  });

  it("keeps the stale/no-state refusal a short fixed message when no config can clamp it", async () => {
    // Only the gates with no current configuration (stale registration, missing state) use
    // the fixed bounded constant; there is no maxOutputBytes to clamp against there.
    const cwd = newCwd();
    for (const options of [{ noState: true }, { isCurrent: () => false }]) {
      const execute = makeHarness(cwd, { ...options, config: { maxOutputBytes: 0 } });
      await expect(
        execute("call-unavailable-fixed", { code: "return 1;" }, undefined, undefined, ctx),
      ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE);
    }
    expect(utf8ByteLength(CODE_MODE_UNAVAILABLE_MESSAGE)).toBeLessThan(512);
  });

  it("clamps the current-but-unavailable refusal through the configured maxOutputBytes", async () => {
    // A disabled/untrusted session still has a current configuration, so even its refusal
    // obeys the configured clamp instead of a fixed unclamped constant.
    const cwd = newCwd();
    const messageFor = async (maxOutputBytes: number): Promise<string> => {
      const execute = makeHarness(cwd, { available: false, config: { maxOutputBytes } });
      try {
        await execute(
          `call-unavailable-clamped-${maxOutputBytes}`,
          { code: "return 1;" },
          undefined,
          undefined,
          ctx,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected an unavailable refusal");
    };
    // Zero budget: the refusal is empty - nothing model-visible leaks past the clamp.
    expect(await messageFor(0)).toBe("");
    // Tiny budget: truncated within the byte budget.
    const tiny = await messageFor(16);
    expect(utf8ByteLength(tiny)).toBeLessThanOrEqual(16);
    expect(CODE_MODE_UNAVAILABLE_MESSAGE.startsWith(tiny)).toBe(true);
    // Exact budget: an exact fit passes through unchanged (the message is pure ASCII, so
    // byte length equals character length and no multibyte boundary can be split).
    const exactBudget = utf8ByteLength(CODE_MODE_UNAVAILABLE_MESSAGE);
    expect(await messageFor(exactBudget)).toBe(CODE_MODE_UNAVAILABLE_MESSAGE);
    // One byte under: still clamped inside the budget.
    const under = await messageFor(exactBudget - 1);
    expect(utf8ByteLength(under)).toBeLessThanOrEqual(exactBudget - 1);
    expect(under).not.toBe(CODE_MODE_UNAVAILABLE_MESSAGE);
  });
});

describe("cumulative nested output budget", () => {
  it("admits an exact cumulative fit and refuses the first overrun model-safely", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "12345678" });
    const exactExecute = makeHarness(cwd, {
      config: { maxCumulativeChildOutputBytes: 16 },
      definitions,
    });
    const program =
      "const one = await tools.pi.read({ path: 'a' });\n" +
      "const two = await tools.pi.read({ path: 'b' });\n" +
      "return one + two;";
    const exact = await exactExecute("call-budget", { code: program }, undefined, undefined, ctx);
    expect(textOf(exact)).toBe("1234567812345678");

    const overExecute = makeHarness(cwd, {
      config: { maxCumulativeChildOutputBytes: 15 },
      definitions,
    });
    await expect(
      overExecute("call-budget-over", { code: program }, undefined, undefined, ctx),
    ).rejects.toThrow(/\[ToolFailure\].*cumulative nested-output budget.*8 of 15 bytes/s);
  });

  it("counts multibyte guest data in exact UTF-8 bytes", async () => {
    const cwd = newCwd();
    // 4 characters, 8 UTF-8 bytes.
    const definitions = fakeDefinitions({ read: async () => "éééé" });
    const execute = makeHarness(cwd, {
      config: { maxCumulativeChildOutputBytes: 8 },
      definitions,
    });
    const fits = await execute(
      "call-multibyte",
      { code: "return await tools.pi.read({ path: 'a' });" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(fits)).toBe("éééé");

    const refusing = makeHarness(cwd, {
      config: { maxCumulativeChildOutputBytes: 7 },
      definitions,
    });
    await expect(
      refusing(
        "call-multibyte-over",
        { code: "return await tools.pi.read({ path: 'a' });" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/cumulative nested-output budget/);
  });

  it("stays exact under parallel nested calls at the fixed runtime concurrency", async () => {
    const cwd = newCwd();
    // Five parallel 4-byte results against a 12-byte budget: exactly three are admitted no
    // matter how the parallel calls settle; the two refusals surface as catchable errors.
    const definitions = fakeDefinitions({ read: async () => "DATA" });
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
    const result = await execute("call-parallel", { code: program }, undefined, undefined, ctx);
    expect(JSON.parse(textOf(result))).toEqual({ admitted: 3, refused: 2 });
  });
});

describe("cancellation", () => {
  it("returns a cancelled result for a pre-aborted signal without executing anything", async () => {
    const cwd = newCwd();
    const calls: FakeCall[] = [];
    const definitions = fakeDefinitions({ read: async () => "data" }, calls);
    const execute = makeHarness(cwd, { definitions });
    const controller = new AbortController();
    controller.abort();
    const result = await execute(
      "call-preaborted",
      { code: "return await tools.pi.read({ path: 'a' });" },
      controller.signal,
      undefined,
      ctx,
    );
    expect(textOf(result)).toBe("Execution cancelled.");
    expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("aborts mid-flight executions and their nested calls through the outer signal", async () => {
    const cwd = newCwd();
    const calls: FakeCall[] = [];
    let nestedStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      nestedStarted = resolve;
    });
    const definitions = fakeDefinitions(
      {
        read: (_input, signal) =>
          new Promise((_resolve, reject) => {
            nestedStarted?.();
            signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      },
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
    await started;
    controller.abort();
    const result = await pending;
    expect(textOf(result)).toBe("Execution cancelled.");
    expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("settles as cancelled when the session runtime is replaced or shut down mid-run", async () => {
    const cwd = newCwd();
    let current = true;
    const disposal = new AbortController();
    const definitions = fakeDefinitions({
      read: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const execute = makeHarness(cwd, {
      definitions,
      isCurrent: () => current,
      // The managed session runtime interrupts running fibers on disposal; the disposal
      // controller stands in for that interruption here.
      runInSession: (effect, signal) =>
        Effect.runPromise(
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = false;
    disposal.abort();
    const result = await pending;
    expect(textOf(result)).toBe("Execution cancelled.");
    expect((result.details as CodeModeToolDetails).cancelled).toBe(true);
  });
});

describe("progress", () => {
  it("keeps tracked rows bounded while preserving exact counts above 256 calls", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "ok" });
    const execute = makeHarness(cwd, {
      definitions,
      config: { maxToolCalls: 300 },
    });
    const result = await execute(
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
    );
    expect(result.details.counts).toMatchObject({
      total: 300,
      succeeded: 300,
      failed: 0,
      queued: 0,
      running: 0,
    });
    expect(result.details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
  });

  it("forwards bounded start/end progress without nested output and stops after settle", async () => {
    const cwd = newCwd();
    const secret = "SECRET-NESTED-OUTPUT";
    const definitions = fakeDefinitions({ read: async () => secret });
    const execute = makeHarness(cwd, { definitions });
    const updates: Array<{ text: string; details: CodeModeToolDetails }> = [];
    const result = await execute(
      "call-progress",
      { code: "return await tools.pi.read({ path: 'a' });" },
      undefined,
      (partial) => {
        updates.push({ text: textOf(partial), details: partial.details });
      },
      ctx,
    );
    expect(textOf(result)).toBe(secret);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const updateCountAtSettle = updates.length;
    for (const update of updates) {
      expect(update.text).not.toContain(secret);
      expect(update.text).toContain("pi.read");
      expect(update.details.toolCalls[0]?.tool).toBe("pi.read");
    }
    expect(updates[0]?.details.toolCalls[0]?.status).toBe("queued");
    expect(updates.some((update) => update.details.toolCalls[0]?.status === "running")).toBe(true);
    expect(updates.at(-1)?.details.toolCalls[0]?.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.length).toBe(updateCountAtSettle);
  });

  it("falls back to legacy start/end hooks when a reload-cached runtime emits no lifecycle events", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "legacy-data" });
    const executeCodeMode: NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]> = (
      options,
    ) => {
      const { onToolCallLifecycle: _ignored, ...legacyOptions } = options;
      return CodeMode.execute(legacyOptions);
    };
    const execute = makeHarness(cwd, { definitions, executeCodeMode });
    const result = await execute(
      "call-legacy-runtime",
      { code: "return await tools.pi.read({ path: 'legacy.txt' });" },
      undefined,
      undefined,
      ctx,
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
  });

  it("accepts an optional intent and records bounded activity labels from decoded input", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "data", grep: async () => "hits" });
    const execute = makeHarness(cwd, { definitions });
    const withIntent = await execute(
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
    );
    expect(textOf(withIntent)).toBe("hits");
    const details = withIntent.details as CodeModeToolDetails;
    expect(details.toolCalls.map((call) => call.activity)).toEqual([
      "Read src/a.ts",
      "Search TODO in cwd",
    ]);
    // Intent never affects execution: the same program without it yields the same output.
    const withoutIntent = await execute(
      "call-no-intent",
      { code: "return await tools.pi.grep({ pattern: 'TODO' });" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(withoutIntent)).toBe("hits");
  });

  it("survives hostile onUpdate callbacks: sync throws and rejecting thenables", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({ read: async () => "data" });
    const execute = makeHarness(cwd, { definitions });
    let invocations = 0;
    const result = await execute(
      "call-hostile",
      { code: "return await tools.pi.read({ path: 'a' });" },
      undefined,
      (() => {
        invocations += 1;
        if (invocations % 2 === 0) throw new Error("hostile sync throw");
        return Promise.reject(new Error("hostile rejection")) as unknown as void;
      }) as never,
      ctx,
    );
    expect(textOf(result)).toBe("data");
    expect(invocations).toBeGreaterThanOrEqual(2);
    // A rejected thenable from the host is absorbed; give it a tick to surface if not.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("diagnostics and errors", () => {
  it("reports parse errors with the normalized diagnostic kind", async () => {
    const execute = makeHarness(newCwd());
    await expect(
      execute("call-parse", { code: "return await (" }, undefined, undefined, ctx),
    ).rejects.toThrow(/\[ParseError\]/);
  });

  it("charges catchable nested failure text to the cumulative child-output budget", async () => {
    const cwd = newCwd();
    const definitions = fakeDefinitions({
      bash: async () => {
        throw new Error("failure-" + "x".repeat(1_000));
      },
    });
    const execute = makeHarness(cwd, {
      definitions,
      config: { maxCumulativeChildOutputBytes: 48 },
    });
    const result = await execute(
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
    );
    const observed = JSON.parse(textOf(result)) as { message: string; length: number };
    expect(observed.length).toBeLessThanOrEqual(48);
    expect(observed.message).toContain("Nested tool 'bash' failed");
    expect(observed.message).not.toContain("x".repeat(100));
  });

  it("retains settled lifecycle details before an uncaught runtime failure is thrown", async () => {
    const cwd = newCwd();
    const retained: Array<{ id: string; details: CodeModeToolDetails }> = [];
    const execute = makeHarness(cwd, {
      retainFailureDetails: (id, details) => retained.push({ id, details }),
    });
    await expect(
      execute(
        "call-retained-failure",
        { code: `return await tools.pi.read({ path: ${JSON.stringify(join(cwd, "missing"))} });` },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/ToolFailure/);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.id).toBe("call-retained-failure");
    expect(retained[0]?.details.toolCalls[0]?.status).toBe("error");
    expect(retained[0]?.details.counts).toMatchObject({ total: 1, failed: 1 });
  });

  it("lets programs observe nested tool failures with try/catch", async () => {
    const cwd = newCwd();
    const execute = makeHarness(cwd);
    const program = `
      try {
        await tools.pi.read({ path: ${JSON.stringify(join(cwd, "missing.txt"))} });
        return "unexpected";
      } catch (error) {
        return "caught: " + error.message;
      }
    `;
    const result = await execute("call-caught", { code: program }, undefined, undefined, ctx);
    expect(textOf(result)).toContain("caught:");
    expect(textOf(result)).toContain("Nested tool 'read' failed");
  });

  it("preserves console logs in the model-visible output", async () => {
    const execute = makeHarness(newCwd());
    const result = await execute(
      "call-logs",
      { code: "console.log('probe log'); return 'done';" },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toBe("done\n\nLogs:\nprobe log");
  });
});
