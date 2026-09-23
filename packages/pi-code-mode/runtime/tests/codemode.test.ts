import { runtimeTypeName } from "../src/runtime-values.js";
import { boundOutput } from "../src/interpreter/host-execution.js";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { CodeMode, Tool, toolError } from "../src/index.js";

const run = (tool: Tool.Definition<never>) =>
  CodeMode.make({ tools: { host: { call: tool } } }).execute("return await tools.host.call({})");

const ResultFromJsonString = Schema.fromJsonString(CodeMode.Result);
const encodeResult = Schema.encodeSync(ResultFromJsonString);
const decodeResult = Schema.decodeUnknownSync(ResultFromJsonString);

class UnsafeHostError extends Schema.TaggedError<UnsafeHostError>()("UnsafeHostError", {
  reason: Schema.String,
}) {}

describe("CodeMode host failure boundary", () => {
  it.live("preserves explicit safe tool failures", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Tool.make({
          description: "Fail safely",
          input: Schema.Struct({}),
          output: Schema.String,
          run: () => Effect.fail(toolError("Authorized request was refused")),
        }),
      );

      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: "ToolFailure",
        message: "Authorized request was refused",
      });
    }),
  );

  it.live("sanitizes unknown host failures and defects", () =>
    Effect.gen(function* () {
      for (const failure of [
        Effect.fail(new UnsafeHostError({ reason: "Authorization: Bearer typed-secret" })),
        Effect.die(new Error("postgres://user:defect-secret@example.invalid")),
      ]) {
        const result = yield* run(
          Tool.make({
            description: "Fail internally",
            input: Schema.Struct({}),
            output: Schema.String,
            run: () => failure,
          }),
        );

        expect(result.ok ? undefined : result.error).toStrictEqual({
          kind: "ToolFailure",
          message: "Tool execution failed",
        });
        expect(encodeResult(result)).not.toMatch(
          /typed-secret|defect-secret|Authorization: Bearer/,
        );
      }
    }),
  );

  it.live("sanitizes invalid host output", () =>
    Effect.gen(function* () {
      const secret = "invalid-output-secret";
      const RejectingString = Schema.Number.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((): string => {
            throw new Error("intentional invalid host output");
          }),
          encode: SchemaGetter.transform(() => 0),
        }),
      );
      const result = yield* run(
        Tool.make({
          description: "Return invalid output",
          input: Schema.Struct({}),
          output: Schema.Struct({ safe: RejectingString }),
          run: () => Effect.succeed({ safe: 1, secret }),
        }),
      );

      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: "InvalidToolOutput",
        message: "Invalid output from tool 'host.call'.",
      });
      expect(encodeResult(result)).not.toMatch(/invalid-output-secret/);
    }),
  );

  it.live("sanitizes host output that throws while being copied", () =>
    Effect.gen(function* () {
      const result = yield* run(
        Tool.make({
          description: "Return hostile output",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          run: () =>
            Effect.succeed(
              new Proxy(
                {},
                {
                  ownKeys: () => {
                    throw new Error("host-output-secret");
                  },
                },
              ),
            ),
        }),
      );

      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: "InvalidToolOutput",
        message: "Invalid output from tool 'host.call'.",
      });
      expect(encodeResult(result)).not.toMatch(/host-output-secret/);
    }),
  );

  it.live("caught tool failures are Error values in-program", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.make({
        tools: {
          host: {
            call: Tool.make({
              description: "Refuse",
              input: Schema.Struct({}),
              output: Schema.String,
              run: () => Effect.fail(toolError("Refused")),
            }),
          },
        },
      }).execute(`
        try {
          await tools.host.call({})
          return "no"
        } catch (e) {
          return { isError: e instanceof Error, message: e.message }
        }
      `);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toStrictEqual({ isError: true, message: "Refused" });
    }),
  );

  it.live("propagates host interruption instead of returning a diagnostic", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        CodeMode.make({
          tools: {
            host: {
              call: Tool.make({
                description: "Interrupt",
                input: Schema.Struct({}),
                output: Schema.String,
                run: () => Effect.interrupt,
              }),
            },
          },
        }).execute("return await tools.host.call({})"),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    }),
  );
});

describe("CodeMode tool-call observation", () => {
  it.live("reports the tools actually invoked with decoded input", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const lookup = Tool.make({
        description: "Look up a value",
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        run: ({ query }) => Effect.succeed(query),
      });

      const result = yield* CodeMode.make({
        tools: { context: { lookup } },
        onToolCallStart: (call) => Effect.sync(() => calls.push(call)),
      }).execute(`
        if (false) await tools.context.lookup({ query: "not called" })
        return await tools.context.lookup({ query: "deployment failure" })
      `);

      expect(result.ok).toBe(true);
      expect(calls).toStrictEqual([
        { index: 0, name: "context.lookup", input: { query: "deployment failure" } },
      ]);
    }),
  );

  it.live("observes queued, running, and terminal lifecycle states with stable ids", () =>
    Effect.gen(function* () {
      const events: Array<CodeMode.ToolCallLifecycleEvent> = [];
      const sleepy = Tool.make({
        description: "Sleep briefly",
        input: Schema.Struct({ id: Schema.Number }),
        output: Schema.Number,
        run: ({ id }) => Effect.sleep(20).pipe(Effect.as(id)),
      });
      const calls = Array.from(
        { length: 12 },
        (_, index) => `tools.context.sleepy({ id: ${index} })`,
      ).join(", ");

      const result = yield* CodeMode.execute({
        tools: { context: { sleepy } },
        code: `return await Promise.all([${calls}])`,
        onToolCallLifecycle: (event) => Effect.sync(() => events.push(event)),
      });

      expect(result.ok).toBe(true);
      const queued = events.filter((event) => event.status === "queued");
      const running = events.filter((event) => event.status === "running");
      const succeeded = events.filter((event) => event.status === "succeeded");
      expect(queued).toHaveLength(12);
      expect(running).toHaveLength(12);
      expect(succeeded).toHaveLength(12);
      expect(new Set(queued.map((event) => event.id)).size).toBe(12);
      for (const event of events) {
        if (event.status === "running") expect(event.queueDurationMs).toBeGreaterThanOrEqual(0);
        if (event.status === "succeeded") expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }
      const ninthQueued = events.findIndex((event) => event.status === "queued" && event.id === 8);
      const firstSucceeded = events.findIndex((event) => event.status === "succeeded");
      expect(ninthQueued).toBeGreaterThanOrEqual(0);
      expect(ninthQueued).toBeLessThan(firstSucceeded);
    }),
  );

  it.live("observes settled calls with outcome and duration", () =>
    Effect.gen(function* () {
      const events: Array<{
        phase: string;
        index: number;
        name: string;
        outcome?: string;
        message?: string;
      }> = [];
      const lookup = Tool.make({
        description: "Look up a value",
        input: Schema.Struct({ query: Schema.String }),
        output: Schema.String,
        run: ({ query }) =>
          query === "boom" ? Effect.fail(toolError("Lookup refused")) : Effect.succeed(query),
      });

      const runtime = CodeMode.make({
        tools: { context: { lookup } },
        onToolCallStart: (call) =>
          Effect.sync(() => {
            events.push({ phase: "start", index: call.index, name: call.name });
          }),
        onToolCallEnd: (call) =>
          Effect.sync(() => {
            expect(call.durationMs).toBeGreaterThanOrEqual(0);
            const event =
              call.message === undefined
                ? { phase: "end", index: call.index, name: call.name, outcome: call.outcome }
                : {
                    phase: "end",
                    index: call.index,
                    name: call.name,
                    outcome: call.outcome,
                    message: call.message,
                  };
            events.push(event);
          }),
      });

      const success = yield* runtime.execute(`return await tools.context.lookup({ query: "ok" })`);
      expect(success.ok).toBe(true);
      const failure = yield* runtime.execute(
        `return await tools.context.lookup({ query: "boom" })`,
      );
      expect(failure.ok).toBe(false);

      expect(events).toStrictEqual([
        { phase: "start", index: 0, name: "context.lookup" },
        { phase: "end", index: 0, name: "context.lookup", outcome: "success" },
        { phase: "start", index: 0, name: "context.lookup" },
        {
          phase: "end",
          index: 0,
          name: "context.lookup",
          outcome: "failure",
          message: "Lookup refused",
        },
      ]);
    }),
  );
});

describe("CodeMode console capture", () => {
  it.live("captures console output as bounded result logs", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        const returned = console.log("Thread info:", { name: "Demo", count: 2 })
        console.warn("careful")
        return returned
      `,
      });

      expect(result).toStrictEqual({
        ok: true,
        value: null,
        logs: ['Thread info: {"name":"Demo","count":2}', "[warn] careful"],
        toolCalls: [],
      });
      expect(decodeResult(encodeResult(result))).toStrictEqual(result);
    }),
  );

  it.live("keeps logs captured before failures", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.log("before failure")
        throw new Error("boom")
      `,
      });

      expect(result.ok ? undefined : result.logs).toStrictEqual(["before failure"]);
      expect(result.ok ? undefined : result.error.message).toBe("Uncaught: boom");
    }),
  );

  it.live("prints NaN and Infinity literally instead of the JSON null", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.log(NaN)
        console.log(Infinity, -Infinity)
        console.log({ ratio: NaN, bounds: [Infinity] })
        return null
      `,
      });

      expect(result.ok).toBe(true);
      expect(result.logs).toStrictEqual([
        "NaN",
        "Infinity -Infinity",
        '{"ratio":NaN,"bounds":[Infinity]}',
      ]);
    }),
  );

  it.live("renders sandbox values nested inside logged containers", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.log({ m: new Map([["a", 1]]), when: new Date(0), r: /ab/g, s: new Set([1, 2]) })
        console.log([new Date(0)])
        return null
      `,
      });

      expect(result.ok).toBe(true);
      expect(result.logs).toStrictEqual([
        '{"m":Map(1) [["a",1]],"when":1970-01-01T00:00:00.000Z,"r":/ab/g,"s":Set(2) [1,2]}',
        "[1970-01-01T00:00:00.000Z]",
      ]);
    }),
  );

  it.live("console formatting is total: cycles and opaque references render as markers", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        const m = new Map()
        m.set("self", m)
        console.log({ box: m })
        console.log({ fn: (x) => x, ok: 1 })
        return null
      `,
      });

      expect(result.ok).toBe(true);
      expect(result.logs).toStrictEqual([
        '{"box":Map(1) [["self",[Circular]]]}',
        '{"fn":[CodeMode reference],"ok":1}',
      ]);
    }),
  );

  it.live("console.table renders sandbox value cells", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.table([{ when: new Date(0), n: NaN }])
        return null
      `,
      });

      expect(result.ok).toBe(true);
      expect(result.logs).toStrictEqual(["(index)\twhen\tn\n0\t1970-01-01T00:00:00.000Z\tNaN"]);
    }),
  );

  it.live("captures console.dir and console.table output", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.dir({ nested: { ok: true } })
        console.table([
          { name: "Kit", count: 1, hidden: "x" },
          { name: "Olive", count: 2, hidden: "y" }
        ], ["name", "count"])
        return "done"
      `,
      });

      expect(result).toStrictEqual({
        ok: true,
        value: "done",
        logs: ['{"nested":{"ok":true}}', "(index)\tname\tcount\n0\tKit\t1\n1\tOlive\t2"],
        toolCalls: [],
      });
    }),
  );
});

describe("CodeMode output budget", () => {
  // Local deviation from upstream (see PROVENANCE.md): confinement truncates oversized
  // console entries during the run, and the missing host budget no longer means an
  // unbounded log entry - only an unbounded result value.
  it.live("absent maxOutputBytes means no result truncation; log entries stay bounded", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `console.log("z".repeat(50_000)); return "x".repeat(100_000)`,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBeUndefined();
      expect(result.value).toBe("x".repeat(100_000));
      expect(result.logs).toHaveLength(1);
      expect(result.logs?.[0]).toMatch(/^z+… \[log entry truncated to 8192 characters\]$/);
    }),
  );

  it.live("preserves complete replacement characters in bounded values and diagnostics", () =>
    Effect.gen(function* () {
      for (const [text, limit, expected] of [
        ["�x", 3, "�"],
        ["�x", 2, ""],
        ["🙂x", 3, ""],
        ["éx", 2, "é"],
        ["�", 3, "�"],
        ["�", 0, ""],
      ] as const) {
        const failure = boundOutput(
          {
            ok: false,
            error: { kind: "ExecutionFailure", message: text },
            toolCalls: [],
          },
          limit,
        );
        expect(failure.ok).toBe(false);
        if (!failure.ok) expect(failure.error.message).toBe(expected);
      }

      const exact = yield* CodeMode.execute({
        code: 'return "�x";',
        tools: {},
        limits: { maxOutputBytes: 4 },
      });
      expect(exact).toStrictEqual({ ok: true, value: "�x", toolCalls: [] });

      const oversized = yield* CodeMode.execute({
        code: 'return "🙂éx";',
        tools: {},
        limits: { maxOutputBytes: 5 },
      });
      expect(oversized).toMatchObject({ ok: true, value: "🙂", truncated: true });

      const marked = yield* CodeMode.execute({
        code: 'return "🙂".repeat(100);',
        tools: {},
        limits: { maxOutputBytes: 128 },
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      expect(marked.truncated).toBe(true);
      expect(runtimeTypeName(marked.value)).toBe("string");
      // SAFETY: The preceding runtime type assertion establishes this successful value as a string.
      const markedText = marked.value as string;
      expect(markedText).toMatch(
        /^(?:🙂)+ \[result truncated: 400 bytes exceeds the 128-byte output limit; return a smaller value\]$/u,
      );
      expect(new TextEncoder().encode(markedText).byteLength).toBeLessThanOrEqual(128);
      expect(markedText).not.toContain("�");
    }),
  );

  it.live("measures top-level strings verbatim while structured values stay compact JSON", () =>
    Effect.gen(function* () {
      const exactCases = [
        [`return "x".repeat(51_200);`, "x".repeat(51_200), 51_200],
        [
          String.raw`return ["\n", "\t", '"', "\\"].join("").repeat(128);`,
          '\n\t"\\'.repeat(128),
          512,
        ],
      ] as const;
      for (const [code, expected, maxOutputBytes] of exactCases) {
        const result = yield* CodeMode.execute({ code, limits: { maxOutputBytes } });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value).toBe(expected);
        expect(result.truncated).toBeUndefined();
      }

      const escapeHeavy = '\n\t"\\'.repeat(128);
      const structured = boundOutput(
        { ok: true, value: { text: escapeHeavy }, toolCalls: [] },
        512,
      );
      expect(structured.ok).toBe(true);
      if (!structured.ok) return;
      expect(structured.truncated).toBe(true);
      expect(runtimeTypeName(structured.value)).toBe("string");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect(new TextEncoder().encode(structured.value as string).byteLength).toBeLessThanOrEqual(
        512,
      );
    }),
  );

  // Local deviation from upstream (see PROVENANCE.md): the truncation marker is reserved
  // INSIDE the byte budget - value bytes + marker bytes never exceed maxOutputBytes, and a
  // budget too small for the marker degrades to bare code-point-safe truncation.
  it.live("truncates an oversized result value inside the budget", () =>
    Effect.gen(function* () {
      const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

      const tiny = yield* CodeMode.execute({
        code: `return { data: "${"x".repeat(200)}" }`,
        limits: { maxOutputBytes: 40 },
      });
      expect(tiny.ok).toBe(true);
      if (!tiny.ok) return;
      expect(tiny.truncated).toBe(true);
      expect(runtimeTypeName(tiny.value)).toBe("string");
      // The marker alone would exceed 40 bytes, so the value is bare-truncated to the budget.
      expect(tiny.value).toBe('{"data":"' + "x".repeat(31));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect(bytes(tiny.value as string)).toBe(40);

      const roomy = yield* CodeMode.execute({
        code: `return { data: "${"x".repeat(400)}" }`,
        limits: { maxOutputBytes: 256 },
      });
      expect(roomy.ok).toBe(true);
      if (!roomy.ok) return;
      expect(roomy.truncated).toBe(true);
      expect(roomy.value).toMatch(
        /^\{"data":"x+ \[result truncated: \d+ bytes exceeds the 256-byte output limit; return a smaller value\]$/,
      );
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect(bytes(roomy.value as string)).toBeLessThanOrEqual(256);
      expect(decodeResult(encodeResult(roomy))).toStrictEqual(roomy);
    }),
  );

  // Local deviation from upstream (see PROVENANCE.md): the logs-truncated marker is itself
  // budgeted - kept lines are dropped until value + logs + marker fit, and the marker is
  // omitted entirely when even it alone cannot fit.
  it.live("keeps leading logs within the remaining budget and marks the cut inside it", () =>
    Effect.gen(function* () {
      const roomy = yield* CodeMode.execute({
        code: `
        console.log("first line")
        console.log("${"y".repeat(200)}")
        return "ok"
      `,
        limits: { maxOutputBytes: 96 },
      });
      expect(roomy.ok).toBe(true);
      if (!roomy.ok) return;
      expect(roomy.value).toBe("ok");
      expect(roomy.truncated).toBe(true);
      expect(roomy.logs).toStrictEqual(["first line", "[logs truncated: showing 1 of 2 lines]"]);

      const tiny = yield* CodeMode.execute({
        code: `
        console.log("first line")
        console.log("${"y".repeat(200)}")
        return "ok"
      `,
        limits: { maxOutputBytes: 40 },
      });
      expect(tiny.ok).toBe(true);
      if (!tiny.ok) return;
      expect(tiny.value).toBe("ok");
      expect(tiny.truncated).toBe(true);
      // Neither the second line nor a marker fits the 36 remaining bytes alongside the first
      // line, and the bare marker alone does not fit either - so logs are dropped entirely.
      expect(tiny.logs).toBeUndefined();
    }),
  );

  it.live("does not mark results within the budget", () =>
    Effect.gen(function* () {
      const result = yield* CodeMode.execute({
        code: `
        console.log("fits")
        return { fits: true }
      `,
      });
      expect(result).toStrictEqual({
        ok: true,
        value: { fits: true },
        logs: ["fits"],
        toolCalls: [],
      });
    }),
  );
});

describe("CodeMode schema flexibility", () => {
  it.live("accepts render-only JSON Schema input and omitted output", () =>
    Effect.gen(function* () {
      const observed: Array<unknown> = [];
      const call = Tool.make({
        description: "Call an adapter-described tool",
        input: {
          type: "object",
          properties: { id: { type: "string" }, count: { type: "number" } },
          required: ["id"],
        },
        run: (input) =>
          Effect.sync(() => {
            observed.push(input);
            return { echoed: input };
          }),
      });
      const runtime = CodeMode.make({ tools: { adapter: { call } } });

      expect(runtime.catalog()).toStrictEqual([
        {
          path: "adapter.call",
          description: "Call an adapter-described tool",
          signature:
            "tools.adapter.call(input: {\n  id: string,\n  count?: number,\n}): Promise<unknown>",
        },
      ]);

      // JSON Schema is render-only: mistyped input passes through unvalidated.
      const result = yield* runtime.execute(`return await tools.adapter.call({ id: 42 })`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toStrictEqual({ echoed: { id: 42 } });
      expect(observed).toStrictEqual([{ id: 42 }]);
    }),
  );

  it.live("renders JSON Schema outputs and $defs references", () =>
    Effect.gen(function* () {
      const lookup = Tool.make({
        description: "Look up a user",
        input: { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
        output: {
          $ref: "#/$defs/User",
          $defs: {
            User: {
              type: "object",
              properties: { login: { type: "string" }, id: { type: "number" } },
              required: ["login", "id"],
            },
          },
        },
        run: () => Effect.succeed({ login: "kit", id: 7 }),
      });
      const runtime = CodeMode.make({ tools: { users: { lookup } } });

      expect(runtime.catalog()).toStrictEqual([
        {
          path: "users.lookup",
          description: "Look up a user",
          signature:
            "tools.users.lookup(input: {\n  login: string,\n}): Promise<{\n  login: string,\n  id: number,\n}>",
        },
      ]);

      const result = yield* runtime.execute(`return await tools.users.lookup({ login: "kit" })`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toStrictEqual({ login: "kit", id: 7 });
    }),
  );

  it.live(
    "Effect Schema output without an input transform still renders unknown when omitted",
    () =>
      Effect.gen(function* () {
        const ping = Tool.make({
          description: "Ping",
          input: Schema.Struct({ host: Schema.String }),
          run: () => Effect.succeed("pong"),
        });
        const runtime = CodeMode.make({ tools: { net: { ping } } });
        expect(runtime.catalog()[0]?.signature).toBe(
          "tools.net.ping(input: {\n  host: string,\n}): Promise<unknown>",
        );

        const result = yield* runtime.execute(
          `return await tools.net.ping({ host: "example.test" })`,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toBe("pong");
      }),
  );
});
