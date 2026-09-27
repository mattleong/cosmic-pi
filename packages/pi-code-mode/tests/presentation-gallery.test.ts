import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { withCodePreviewShell } from "pi-code-previews";
import {
  applyPresentationSettings,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { deferredPromise } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { CodeModeConfig } from "../src/config/schema.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";
import type { CodeModeInput } from "../src/tools/result-read.ts";
import { executeHarness, type CallOptions, type ExecuteHarnessOptions } from "./support/execute.ts";
import { recordingResults } from "./support/results.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: {},
});
const testFailure =
  "> vitest run\n\n FAIL  tests/auth.test.ts > rejects expired tokens\nAssertionError: expected 401 to be 200\n\nCommand exited with code 1";
const readFixture = {
  execute: (_id: string, input: { path: string }) =>
    input.path.startsWith("missing")
      ? Promise.reject(
          new Error(`ENOENT: no such file or directory, open '/project/${input.path}'`),
        )
      : Promise.resolve(text("contents")),
};
const grepFixture = {
  execute: () => Promise.resolve(text("src/auth.ts:12: // TODO refresh expired tokens")),
};
const definitions = nestedToolDefinitionsFixture({
  bash: {
    execute: (_id: string, input: { command: string }) =>
      input.command === "ok" ? Promise.resolve(text("ok")) : Promise.reject(new Error(testFailure)),
  },
  read: readFixture,
  grep: grepFixture,
  edit: {
    execute: (_id: string, input: { path: string }) =>
      Promise.reject(
        new Error(
          `Could not find the exact text in /project/${input.path}. The old text must match exactly including all whitespace and newlines.`,
        ),
      ),
  },
});

const TEST_RUN =
  "await tools.pi.read({path:'package.json'});\nawait tools.pi.bash({command:'pnpm test'});";
const LONG_OUTPUT = [
  "await tools.pi.read({path:'package.json'});",
  "const lines = [];",
  "for (let i = 1; i <= 40; i++) lines.push('PASS tests/module-' + i + '.test.ts (12 tests)');",
  "return lines.join('\\n');",
].join("\n");
const LIVE_CHECKS = [
  "await tools.pi.read({path:'package.json'});",
  "const checks = await Promise.allSettled([",
  "  tools.pi.read({path:'missing-tsconfig.json'}),",
  "  tools.pi.grep({pattern:'TODO', path:'src'}),",
  "  tools.pi.bash({command:'pnpm test'}),",
  "  tools.pi.bash({command:'pnpm lint'}),",
  "]);",
  "return checks.map((check) => check.status);",
].join("\n");
const RETAINED_ID = "cm-2k9f7x-1m4q8z-1";
const FAILURE_ID = "cm-2k9f7x-1m4q8z-2";

type ProgramScenario = readonly [string, string, Partial<CodeModeConfig>?];

const successes: ReadonlyArray<ProgramScenario> = [
  [
    "returns a value",
    "await tools.pi.read({path:'package.json'});\nconst todos = await tools.pi.grep({pattern:'TODO', path:'src'});\nreturn {package: 'demo', todos: 1};",
  ],
  ["returns text without calls", "return 'All 12 tests passed';"],
  [
    "console logs",
    "console.log('Reading package.json');\nawait tools.pi.read({path:'package.json'});\nconsole.log('Checked 1 file');\nreturn 'ok';",
  ],
  ["long output not saved", LONG_OUTPUT, { maxOutputBytes: 600 }],
];

const failures: ReadonlyArray<ProgramScenario> = [
  ["test run fails", TEST_RUN],
  [
    "program handles failed calls",
    "const r = await Promise.allSettled([tools.pi.read({path:'a.ts'}), tools.pi.read({path:'missing-b.ts'}), tools.pi.edit({path:'src/x.ts', edits:[{oldText:'a',newText:'b'}]})]);\nreturn r.map((x) => x.status);",
  ],
  [
    "property of undefined",
    "const files = await tools.pi.read({path:'a.ts'});\nconst x = undefined;\nreturn x.map((y) => y);",
  ],
  ["invalid tool input", "await tools.pi.read({file:'a.ts'});"],
  ["caught invalid tool input", "try { await tools.pi.read({file:'a.ts'}); } catch {}\nreturn 1;"],
  ["unknown tool", "await tools.pi.grepp({pattern:'x'});"],
  ["syntax error", "const a = 1;\nconst b = ;"],
  ["unsupported syntax", "class A {}"],
  ["timeout", "while (true) {}", { timeoutMs: 100 }],
  [
    "call limit",
    "for (const p of ['a','b','c']) await tools.pi.read({path:p});",
    { maxToolCalls: 2 },
  ],
  ["thrown message", "throw new Error('No matching config found in 3 packages');"],
  ["non-data result", "return () => 1;"],
];

interface Settled {
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
}

/**
 * One real execute path. A thrown failure comes back as Pi presents it: the message as content
 * and the details the `tool_result` hook reattaches, or Pi's empty details when none were kept.
 */
const session = (options: ExecuteHarnessOptions = {}) => {
  const harness = executeHarness({
    definitions,
    cwd: "/project",
    ...options,
    retainFailureDetails: true,
  });
  const outcome = (call: Promise<AgentToolResult<CodeModeToolDetails>>): Promise<Settled> =>
    call.then(
      (result) => ({ result, isError: false }),
      (error: Error) => ({
        result: { ...text(error.message), details: harness.retention.consume("call") ?? {} },
        isError: true,
      }),
    );
  return {
    call: harness.call,
    outcome,
    settle: (input: CodeModeInput, callOptions?: CallOptions) =>
      Effect.promise(() => outcome(harness.call(input, callOptions))),
  };
};

/** Pending, first partial, mid-run partial and cancellation of one program. */
const liveRun = Effect.gen(function* () {
  const midway = deferredPromise();
  const cancelled = deferredPromise<Settled>();
  const held = nestedToolDefinitionsFixture({
    read: readFixture,
    grep: grepFixture,
    // Commands run until the gallery cancels the program.
    bash: {
      execute: (_id: string, _input: { command: string }, signal: AbortSignal | undefined) => {
        const command = deferredPromise<never>();
        signal?.addEventListener("abort", () => command.reject(new Error("Command aborted")), {
          once: true,
        });
        return command.promise;
      },
    },
  });
  let starting: AgentToolResult<CodeModeToolDetails> | undefined;
  let running: AgentToolResult<CodeModeToolDetails> | undefined;
  const run = session({ definitions: held });
  const args = { code: LIVE_CHECKS, intent: "Run checks in parallel" };
  const onUpdate = (partial: AgentToolResult<CodeModeToolDetails>) => {
    starting ??= partial;
    const counts = partial.details?.counts;
    if (counts?.running === 2 && counts.succeeded + counts.failed === 3) {
      running = partial;
      midway.resolve();
    }
  };
  // The Pi turn: interrupting it aborts the call's signal, as cancelling a tool call in Pi does.
  const turn = yield* Effect.promise((signal) =>
    run.outcome(run.call(args, { signal, onUpdate })).then(cancelled.resolve),
  ).pipe(Effect.forkChild({ startImmediately: true }));
  yield* Effect.promise(() => midway.promise);
  yield* Fiber.interrupt(turn);
  const settled = yield* Effect.promise(() => cancelled.promise);
  const live: GalleryScenario[] = [
    { title: "awaiting execution", args, phase: "pending" },
    { title: "before the first update", args, phase: "running" },
    { title: "first update", args, result: starting, phase: "running" },
    { title: "checks in flight", args, result: running, phase: "running" },
    { title: "cancelled while checks run", args, ...settled },
  ];
  return live;
});

/** A truncated result kept for result.read, then read page by page until EOF. */
const retainedOutput = Effect.gen(function* () {
  const run = session({
    config: { maxOutputBytes: 600 },
    results: recordingResults(RETAINED_ID).results,
  });
  const args = { code: LONG_OUTPUT, intent: "List passing test files" };
  const execution = yield* Effect.promise(() => run.call(args));
  const pages: Array<{ readonly args: CodeModeInput; readonly result: AgentToolResult<unknown> }> =
    [];
  let next = execution.details.initialPreview?.next ?? null;
  while (next !== null && pages.length < 20) {
    const input = { action: "result.read" as const, id: RETAINED_ID, offset: next };
    const page = yield* Effect.promise(() => run.call(input));
    const read = page.details.resultRead;
    next = read?.status === "page" ? read.next : null;
    pages.push({ args: input, result: page });
  }
  const outside = { action: "result.read" as const, id: RETAINED_ID, offset: 99_999 };
  const retained: GalleryScenario[] = [{ title: "long output saved", args, result: execution }];
  const [first] = pages;
  if (first) retained.push({ title: "result.read · page", ...first });
  const last = pages.at(-1);
  if (last && last !== first) retained.push({ title: "result.read · EOF", ...last });
  retained.push({
    title: "result.read · offset past the end",
    args: outside,
    ...(yield* run.settle(outside)),
  });
  return retained;
});

/** A failed run whose receipt is kept, then read back. */
const failedRun = Effect.gen(function* () {
  const run = session({ results: recordingResults(FAILURE_ID).results });
  const args = { code: TEST_RUN, intent: "Run the tests" };
  const read = { action: "result.read" as const, id: FAILURE_ID };
  const missing = { action: "result.read" as const, id: "cm-2k9f7x-1m4q8z-9" };
  const failed: GalleryScenario[] = [
    { title: "test run fails, receipt saved", args, ...(yield* run.settle(args)) },
    { title: "result.read · from a failed run", args: read, ...(yield* run.settle(read)) },
    { title: "result.read · unavailable", args: missing, ...(yield* session().settle(missing)) },
  ];
  return failed;
});

const statusRequests = Effect.gen(function* () {
  const args = { action: "status" as const };
  const status: GalleryScenario[] = [
    { title: "status · limits", args, ...(yield* session().settle(args)) },
    {
      title: "status · refused by output limit",
      args,
      ...(yield* session({ config: { maxOutputBytes: 64 } }).settle(args)),
    },
    {
      title: "status · Code Mode unavailable",
      args,
      ...(yield* session({ isCurrent: () => false }).settle(args)),
    },
  ];
  return status;
});

/** Execution programs, each in a fresh session with its own limits. */
const programs = (list: ReadonlyArray<ProgramScenario>) =>
  Effect.forEach(list, ([title, code, config]) => {
    const args = { code, intent: "Check the project" };
    return Effect.map(
      session(config === undefined ? {} : { config }).settle(args),
      (settled): GalleryScenario => ({ title, args, ...settled }),
    );
  });

/** The registered Code Mode tool in the applied collapsed style; rendering never executes it. */
const registered = () => {
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute: () => Promise.reject(new Error("Rendering must not execute")),
    startUiTicker: () => () => undefined,
  });
  return withCodePreviewShell(owned, {
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
};

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders Code Mode outcomes in both collapsed styles", () =>
    Effect.gen(function* () {
      const results: GalleryScenario[] = [
        ...(yield* liveRun),
        ...(yield* programs(successes)),
        ...(yield* retainedOutput),
        ...(yield* programs(failures)),
        ...(yield* failedRun),
        ...(yield* statusRequests),
      ];
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = registered();
          for (const scenario of results)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-code-mode", lines);
    }),
  );
});
