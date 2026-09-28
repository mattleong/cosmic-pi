import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { CodeModeResult } from "../../src/engine/diagnostic.ts";
import type { ToolCallLifecycleEvent } from "../../src/engine/dispatch.ts";
import { executeProgram, type ExecutionLimits } from "../../src/engine/execute.ts";
import { makeTool, toolError } from "../../src/engine/tool.ts";
import { temporaryDirectory } from "pi-cosmic-core/testing";

const limits: ExecutionLimits = { timeoutMs: 10_000, maxToolCalls: 32, maxOutputBytes: 50_000 };

const tools = {
  demo: {
    echo: makeTool({
      description: "Echo text back",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      run: ({ text }) => Effect.succeed(`echo:${text}`),
    }),
    slow: makeTool({
      description: "Answer after a delay",
      input: Schema.Struct({ ms: Schema.Number, text: Schema.String }),
      output: Schema.String,
      run: ({ ms, text }) => Effect.as(Effect.sleep(ms), text),
    }),
    fail: makeTool({
      description: "Always fails",
      input: Schema.Struct({}),
      run: () => Effect.fail(toolError("nope")),
    }),
    bigint: makeTool({
      description: "Returns data that is not JSON",
      input: Schema.Struct({}),
      run: () => Effect.succeed({ value: 1n }),
    }),
  },
};

const run = (code: string, overrides: Partial<ExecutionLimits> = {}, cwd = process.cwd()) => {
  const events: Array<ToolCallLifecycleEvent> = [];
  return executeProgram({
    code,
    cwd,
    tools,
    limits: { ...limits, ...overrides },
    onToolCallLifecycle: (event) => Effect.sync(() => void events.push(event)),
  }).pipe(Effect.map((result) => ({ result, events })));
};

const failed = (result: CodeModeResult) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed result");
  return result;
};

const terminal = (events: ReadonlyArray<ToolCallLifecycleEvent>) =>
  events.flatMap((event) =>
    event.status === "queued" || event.status === "running"
      ? []
      : [`${event.name}:${event.status}`],
  );

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "native program execution",
  () => {
    it.live("returns strings verbatim, JSON values as data, and console output as logs", () =>
      Effect.gen(function* () {
        const text = yield* run(`console.log("out"); console.error("err"); return "a\\n{b}";`);
        expect(text.result).toEqual({ ok: true, value: "a\n{b}", logs: ["out", "err"] });
        const data = yield* run(
          `return { when: new Date(0), list: [1, undefined], gone: undefined };`,
        );
        expect(data.result).toEqual({
          ok: true,
          value: { when: "1970-01-01T00:00:00.000Z", list: [1, null] },
        });
        const nothing = yield* run(`const x = 1;`);
        expect(nothing.result).toEqual({ ok: true, value: null });
      }),
    );

    it.live("runs tool calls in parallel and reports each call's lifecycle", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `return await Promise.all(["a", "b", "c"].map((text) => tools.demo.echo({ text })));`,
        );
        expect(result).toEqual({ ok: true, value: ["echo:a", "echo:b", "echo:c"] });
        expect(terminal(events).sort()).toEqual([
          "demo.echo:succeeded",
          "demo.echo:succeeded",
          "demo.echo:succeeded",
        ]);
      }),
    );

    it.live("lets siblings of a failed Promise.all finish and returns their output", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `await Promise.all([tools.demo.slow({ ms: 150, text: "late" }), tools.demo.fail({})]);`,
        );
        const failure = failed(result);
        expect(failure.error.kind).toBe("ToolFailure");
        expect(failure.error.facts?.tool).toBe("demo.fail");
        expect(failure.error.location?.line).toBe(1);
        expect(terminal(events).sort()).toEqual(["demo.fail:failed", "demo.slow:succeeded"]);
        expect(failure.completed).toEqual([{ tool: "tools.demo.slow", text: "late" }]);
      }),
    );

    it.live("keeps a successful result when the program catches a tool failure", () =>
      Effect.gen(function* () {
        const { result } = yield* run(
          `try { await tools.demo.fail({}); } catch (error) { return [error.name, error.message]; }`,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toEqual(["ToolError", expect.stringContaining("nope")]);
      }),
    );

    it.live("fails a program that leaves a tool rejection unhandled", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`tools.demo.fail({}); return "done";`);
        const failure = failed(result);
        expect(failure.error.kind).toBe("ToolFailure");
        expect(failure.error.message).toMatch(/un-awaited/u);
      }),
    );

    it.live("refuses unknown tools, invalid input and calls past the limit before dispatch", () =>
      Effect.gen(function* () {
        const unknown = failed((yield* run(`await tools.demo.ech0({ text: "x" });`)).result);
        expect(unknown.error.kind).toBe("UnknownTool");
        expect(unknown.error.suggestions?.join(" ")).toContain("tools.demo.echo");

        const invalid = failed((yield* run(`await tools.demo.echo({ text: 1 });`)).result);
        expect(invalid.error.kind).toBe("InvalidToolInput");
        expect(invalid.error.facts?.field).toEqual(["text"]);

        const limited = yield* run(
          `for (const text of ["a", "b"]) await tools.demo.echo({ text });`,
          { maxToolCalls: 1 },
        );
        expect(failed(limited.result).error.kind).toBe("ToolCallLimitExceeded");
        expect(terminal(limited.events)).toEqual(["demo.echo:succeeded", "demo.echo:failed"]);
      }),
    );

    it.live("reports syntax errors with their location and accepts TypeScript types", () =>
      Effect.gen(function* () {
        const syntax = failed((yield* run(`const ok = 1;\nconst broken = ;`)).result);
        expect(syntax.error.kind).toBe("ParseError");
        expect(syntax.error.location).toEqual({ line: 2, column: 16 });

        const typed = yield* run(
          `const add = (a: number, b: number): number => a + b;\nreturn add(1, 2) as number;`,
        );
        expect(typed.result).toEqual({ ok: true, value: 3 });
      }),
    );

    it.live("runs in the session directory with Node built-ins", () =>
      Effect.gen(function* () {
        const cwd = yield* temporaryDirectory("code-mode-cwd-");
        const { result } = yield* run(
          `const { createHash } = await import("node:crypto");\nreturn [process.cwd().split("/").pop(), createHash("sha1").update("x").digest("hex").length];`,
          {},
          cwd,
        );
        expect(result).toEqual({ ok: true, value: [cwd.split("/").pop(), 40] });
      }).pipe(Effect.scoped),
    );

    it.live("allows direct network use on every Node version", () =>
      Effect.gen(function* () {
        const { result } = yield* run(
          `const http = await import("node:http");
          const server = http.createServer((_request, response) => response.end("pong"));
          await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
          const response = await fetch("http://127.0.0.1:" + server.address().port);
          const text = await response.text();
          server.close();
          return text;`,
        );
        expect(result).toEqual({ ok: true, value: "pong" });
      }),
    );

    it.live("routes file reads, writes, imports and processes through tools", () =>
      Effect.gen(function* () {
        const refused = (code: string) =>
          run(code).pipe(Effect.map(({ result }) => failed(result).error));
        const read = yield* refused(
          `const { readFile } = await import("node:fs/promises");\nawait readFile("package.json", "utf8");`,
        );
        expect(read.message).toContain("tools.pi.read");
        expect(read.location?.line).toBe(2);
        const write = yield* refused(
          `const { writeFile } = await import("node:fs/promises");\nawait writeFile("x.txt", "x");`,
        );
        expect(write.message).toContain("tools.pi.write");
        const imported = yield* refused(`await import("effect");`);
        expect(imported.message).toContain("import project files or packages");
        const spawned = yield* refused(
          `const { execSync } = await import("node:child_process");\nexecSync("true");`,
        );
        expect(spawned.message).toContain("tools.pi.bash");
      }),
    );

    it.live("refuses values that are not JSON at both boundaries", () =>
      Effect.gen(function* () {
        const returned = failed((yield* run(`return { n: 1n };`)).result);
        expect(returned.error.kind).toBe("InvalidDataValue");
        const output = failed((yield* run(`return await tools.demo.bigint({});`)).result);
        expect(output.error.kind).toBe("InvalidToolOutput");
        const input = failed(
          (yield* run(`const a = {}; a.self = a; await tools.demo.echo(a);`)).result,
        );
        expect(input.error.kind).toBe("InvalidDataValue");
      }),
    );

    it.live("stops a looping program at the deadline", () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const { result } = yield* run(`console.log("spinning"); while (true) {}`, {
          timeoutMs: 300,
        });
        const failure = failed(result);
        expect(failure.error.kind).toBe("TimeoutExceeded");
        expect(failure.logs).toEqual(["spinning"]);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000);
      }),
    );

    it.live("cancels calls still running at the deadline", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(`await tools.demo.slow({ ms: 5_000, text: "x" });`, {
          timeoutMs: 300,
        });
        expect(failed(result).error.kind).toBe("TimeoutExceeded");
        expect(terminal(events)).toEqual(["demo.slow:cancelled"]);
      }),
    );

    it.live("stops promptly when interrupted", () =>
      Effect.gen(function* () {
        const fiber = yield* run(`while (true) {}`).pipe(Effect.forkChild);
        yield* Effect.sleep(200);
        const started = yield* Clock.currentTimeMillis;
        yield* Fiber.interrupt(fiber);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3_000);
      }),
    );

    it.live("reports a process that exits before returning", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`process.exit(3);`);
        const failure = failed(result);
        expect(failure.error.kind).toBe("ExecutionFailure");
        expect(failure.error.message).toContain("exit code 3");
      }),
    );

    it.live("refuses tool calls made after the program returned", () =>
      Effect.gen(function* () {
        const { result, events } = yield* run(
          `setTimeout(() => tools.demo.echo({ text: "late" }).catch(() => {}), 50);\nreturn "early";`,
        );
        expect(result).toEqual({ ok: true, value: "early" });
        expect(events).toEqual([]);
      }),
    );

    it.live("keeps a result whose JSON escaping outgrows the frame limit", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`return "\\n".repeat(10 * 1024 * 1024);`, {
          maxOutputBytes: 100,
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.truncated).toBe(true);
      }),
    );

    it.live("bounds oversized results and marks them truncated", () =>
      Effect.gen(function* () {
        const { result } = yield* run(`return "x".repeat(10_000);`, { maxOutputBytes: 200 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.truncated).toBe(true);
          expect(String(result.value)).toMatch(/result truncated/u);
        }
      }),
    );
  },
);
