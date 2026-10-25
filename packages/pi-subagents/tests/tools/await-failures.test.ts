import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import { makePiManagedRuntime, stripAnsi } from "pi-cosmic-core";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { beforeEach, expect } from "vitest";
import { callerNotRegistered, codedFailure, runNotFound } from "../../src/run/errors.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { eventBackendServiceFixture } from "../run/fixtures/service-harness.ts";
import { step } from "../support/effect-test.ts";
import { executeTool } from "./fixtures/tool-harness.ts";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const MISSING = "agent-0123456789";

const settledIssue = (args: { readonly runIds: ReadonlyArray<string> }, text: string) =>
  createSubagentCompactSummary(SUBAGENT_TOOL_NAME.await)({
    phase: "settled",
    args,
    result: { content: [{ type: "text", text }], details: {} },
    context: renderContextFixture({ isError: true }),
  })?.issues?.[0];

it.live("names an unknown awaited run without its ID until the call is expanded", () =>
  Effect.gen(function* () {
    const fixture = eventBackendServiceFixture();
    const { pi, tools } = recordingExtensionHost();
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer)),
      ),
      (owned) => step(() => owned.dispose()),
    );
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: true },
      run: (effect, signal) => runtime.run(effect, signal),
    });
    const tool = tools.get(SUBAGENT_TOOL_NAME.await)!;
    const args = { runIds: [MISSING] };
    // The thrown message is the text Pi shows the model and hands the renderer.
    const text = yield* Effect.tryPromise({
      try: () => executeTool(tool, args),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.flip);
    expect(text).toContain(MISSING);

    const issue = settledIssue(args, text);
    expect(issue).toMatchObject({ severity: "error", code: "agent:subagent_runs_not_found" });
    expect(issueMessageStyleProblems(issue?.message ?? "", { forbidden: [MISSING] })).toEqual([]);
    expect(issue?.detail).toContain(MISSING);
    expect(issue?.detail).toContain("agent_list");

    const [collapsed, expanded] = Arr.map(
      createToolPresentationHarness(tool, { width: 160 }).cycle(
        args,
        { content: [{ type: "text", text }], details: {} },
        { states: [false, true], overrides: () => ({ isError: true, isPartial: false }) },
      ),
      (frame) => stripAnsi(frame.text),
    );
    expect(collapsed).not.toContain(MISSING);
    expect(expanded).toContain(MISSING);
  }),
);

it("tells a caller that is no longer registered apart from a missing target", () => {
  const args = { runIds: [MISSING] };
  const caller = "agent-gonecaller";
  const missingTarget = settledIssue(args, codedFailure(runNotFound(MISSING)).message);
  const missingCaller = settledIssue(args, codedFailure(callerNotRegistered(caller)).message);
  expect(missingCaller).toMatchObject({ severity: "error", code: "agent:caller_not_registered" });
  expect(missingCaller?.message).not.toBe(missingTarget?.message);
  expect(issueMessageStyleProblems(missingCaller?.message ?? "", { forbidden: [caller] })).toEqual(
    [],
  );
  expect(missingCaller?.detail).toContain(caller);
  expect(missingCaller?.detail).not.toContain("agent_list");
});
