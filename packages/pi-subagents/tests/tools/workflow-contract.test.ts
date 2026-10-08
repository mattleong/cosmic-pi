// Registered tool execution is the Promise-shaped host boundary under test.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  captureRegistrations,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import { extensionContextFixture, step } from "pi-cosmic-core/testing";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { registerWorkflowTool } from "../../src/tools/workflow.ts";
import {
  workflowCompactSummary,
  type WorkflowToolArgs,
} from "../../src/tools/workflow-presentation.ts";
import {
  decodeWorkflowContract,
  encodeWorkflowContract,
  WorkflowContractSchema,
} from "../../src/tools/workflow-contract-schema.ts";
import { workflowStatusContract } from "../../src/tools/workflow-contract.ts";
import { WorkflowNotFoundError, WorkflowRequestError } from "../../src/workflow/errors.ts";
import type { WorkflowAgentAttention } from "../../src/workflow/attention.ts";
import type { WorkflowRunView } from "../../src/workflow/model.ts";
import { WorkflowScriptError } from "../../src/workflow/script.ts";
import { WorkflowService, type WorkflowServiceContract } from "../../src/workflow/service.ts";
import { WorkflowStore, type WorkflowListing } from "../../src/workflow/store.ts";
import { workflowAgentView, workflowRunView } from "../fixtures/run-view.ts";
import { memoryLocations, memoryStore, script } from "../workflow/fixtures/workflow-harness.ts";
import { fallbackProfileService, testBackendRegistry } from "./fixtures/tool-harness.ts";

const contractText = Schema.encodeSync(Schema.fromJsonString(WorkflowContractSchema));
const emptyListing: WorkflowListing = {
  workflows: [],
  diagnostics: [],
  truncated: false,
  locations: memoryLocations,
};
const boundary = (overrides: Partial<WorkflowServiceContract>, listing = emptyListing) => {
  const service: WorkflowServiceContract = {
    start: () => Effect.die("Unexpected start"),
    stop: () => Effect.die("Unexpected stop"),
    status: () => Effect.die("Expected toolStatus, never status"),
    toolStatus: () => Effect.die("Unexpected status"),
    list: Effect.succeed([]),
    skip: () => Effect.die("Unexpected skip"),
    ...overrides,
  };
  const [tool] = captureRegistrations((pi) =>
    registerWorkflowTool(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      savedWorkflowLocations: memoryLocations,
      run: (effect, signal) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(WorkflowService, service),
            Effect.provideService(WorkflowStore, {
              ...memoryStore({}),
              list: Effect.succeed(listing),
            }),
            Effect.provideService(SubagentProfileService, fallbackProfileService),
            Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
          ),
          { signal },
        ),
    }),
  ).tools;
  return (args: Partial<WorkflowToolArgs>) =>
    step(() =>
      tool!.execute(
        "test",
        args,
        undefined,
        undefined,
        extensionContextFixture({ cwd: "/project" }),
      ),
    );
};
const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? "").join("\n");
const longPath = `/project/${"long-component/".repeat(150)}script.js`;
const receipt = workflowRunView({
  id: "actual-id",
  name: "actual-name",
  source: { kind: "file", path: longPath },
  scriptPath: longPath,
  resumedFrom: "previous-run",
  budget: { total: 100, spent: 3, refused: 0 },
  warnings: [{ at: 2, level: "warning", message: "Journal unavailable" }],
  args: { hidden: "PRIVATE-ARGS" },
});
const attention: WorkflowAgentAttention[] = Array.from({ length: 15 }, (_, index) => {
  const base = { runId: `agent-${index}`, writer: index % 2 === 0 };
  switch (index % 5) {
    case 0:
      return { ...base, kind: "containment" };
    case 1:
      return { ...base, kind: "admission-paused" };
    case 2:
      return { ...base, kind: "paused", canResume: true };
    case 3:
      return { ...base, kind: "question", message: "Grant src/a.ts?" };
    default:
      return { ...base, kind: "question-unavailable" };
  }
});
const fullRun = (): WorkflowRunView => ({
  ...receipt,
  phases: [
    {
      title: "Work",
      detail: "All files",
      agents: ["writer", { label: "reader", profile: "reviewer" }],
    },
  ],
  currentPhase: "Work",
  agents: Array.from({ length: 30 }, (_, index) => ({
    ...workflowAgentView({
      callId: index + 1,
      runId: `agent-${index}`,
      state: index === 29 ? "completed" : "queued",
    }),
    workspaceId: `workspace-${index}`,
    ...(index === 29 && { unchanged: true as const }),
    phase: "Work",
    profile: "worker",
    startedAt: 2,
    endedAt: 3,
    reason: `Inspect ${longPath}`,
    waiting:
      index % 2 === 0
        ? { kind: "slot" as const }
        : { kind: "writer" as const, runId: "blocked-by", name: "Writer", paused: true },
    task: "PRIVATE-PROMPT",
  })),
  planned: [
    {
      runId: "planned",
      phase: "Work",
      label: "planned",
      profile: "worker",
      workflow: "nested",
      skippedAt: 3,
    },
  ],
  reused: 2,
  reusedPhases: [{ title: "Work", count: 2 }],
  reusedWorkspaces: [{ workspaceId: "old-workspace", label: "reused" }],
  logs: Array.from({ length: 200 }, (_, index) => ({
    at: index,
    level: "info" as const,
    message: `log-${index}`,
  })),
  warnings: Array.from({ length: 12 }, (_, index) => ({
    at: index,
    level: "warning" as const,
    message: `warning-${index}`,
  })),
  warningCount: 40,
  lastLog: "last",
  usage: {
    input: 3,
    output: 4,
    cacheRead: 5,
    cacheWrite: 6,
    totalTokens: 18,
    cost: 0.04,
    toolUses: 2,
    unpriced: 1,
  },
  journalPath: longPath,
  result: { text: '{"incomplete":', clipped: true, path: longPath },
  failure: {
    kind: "runner",
    name: "RunnerError",
    message: "Preserve workspace-29",
    stack: `at ${longPath}`,
  },
});

describe("workflow native contracts at the registered boundary", () => {
  it.effect("returns the actual start receipt without completion or private execution state", () =>
    Effect.gen(function* () {
      const run = {
        ...receipt,
        script: "PRIVATE-SCRIPT",
        owner: "PRIVATE-OWNER",
        sessionKey: "PRIVATE-SESSION",
      };
      const execute = boundary({ start: () => Effect.succeed(run) });
      const output = yield* execute({
        action: "start",
        script: script("return null;"),
      });
      const contract = decodeWorkflowContract(output.structuredContent);
      expect(contract).toEqual({
        contract: "pi-subagents/workflow",
        version: 1,
        tool: "subagent_workflow",
        action: "start",
        run: {
          id: run.id,
          name: run.name,
          state: "running",
          startedAt: 1,
          source: run.source,
          scriptPath: longPath,
          resumedFrom: "previous-run",
          budget: run.budget,
          warnings: run.warnings,
        },
      });
      expect(textOf(output)).toContain(run.id);
      expect(output.details).toMatchObject({ run: { id: run.id } });
      expect(contractText(contract!)).not.toContain("PRIVATE-");
      expect(contractText(contract!)).not.toContain('"finished"');
    }),
  );

  it.effect(
    "preserves every live array, recovery identifier and bounded result without UI limits",
    () =>
      Effect.gen(function* () {
        const run = fullRun();
        const execute = boundary({
          toolStatus: () => Effect.succeed({ kind: "view", run, attention }),
        });
        const output = yield* execute({ action: "status", runId: run.id });
        const contract = decodeWorkflowContract(output.structuredContent);
        if (contract?.action !== "status" || contract.kind !== "view")
          throw new Error("Expected live status");
        expect(contract.attention).toEqual(attention);
        expect(contract.run.agents).toHaveLength(30);
        expect(contract.run.logs).toHaveLength(200);
        expect(contract.run.warnings).toHaveLength(12);
        expect(contract.run.warningCount).toBe(40);
        expect(contract.run.workspaces).toHaveLength(30);
        expect(contract.run.workspaces.some((entry) => entry.workspaceId === "workspace-29")).toBe(
          false,
        );
        expect(contract.run.agents[29]).toMatchObject({
          workspaceId: "workspace-29",
          unchanged: true,
        });
        expect(contract.run).toMatchObject({
          planned: run.planned,
          reusedPhases: run.reusedPhases,
          reusedWorkspaces: run.reusedWorkspaces,
          usage: run.usage,
          result: run.result,
          failure: run.failure,
          source: run.source,
        });
        expect(contractText(contract)).not.toContain("PRIVATE-");
        expect(Object.isFrozen(output.structuredContent)).toBe(true);
        expect(Object.isFrozen(contract.run.agents[0])).toBe(true);
      }),
  );

  it.effect("returns the full current unchanged snapshot rather than last-call UI state", () =>
    Effect.gen(function* () {
      const run = workflowRunView({
        usage: { ...receipt.usage, output: 999 },
        logs: [{ at: 4, level: "info", message: "newest" }],
      });
      const execute = boundary({
        toolStatus: () => Effect.succeed({ kind: "unchanged", run, sinceMs: 12 }),
      });
      const output = yield* execute({ action: "status", runId: run.id });
      expect(output.details).toMatchObject({ unchanged: true });
      expect(decodeWorkflowContract(output.structuredContent)).toMatchObject({
        action: "status",
        kind: "unchanged",
        sinceMs: 12,
        attention: [],
        run: { usage: { output: 999 }, logs: run.logs },
      });
    }),
  );

  it.effect("keeps recorded counts and other-process liveness separate from live snapshots", () =>
    Effect.gen(function* () {
      for (const state of ["running", "interrupted", "completed"] as const) {
        const run = {
          id: "old",
          name: "Earlier run",
          source: { kind: "saved" as const, name: "saved", scope: "user" as const, path: longPath },
          state,
          startedAt: 1,
          finished: 5,
          ...(state === "running"
            ? { runningIn: 777 }
            : { endedAt: 5, stoppedBy: "user" as const }),
          scriptPath: longPath,
          journalPath: longPath,
          args: "PRIVATE-ARGS",
          pid: 123,
          notified: true,
        };
        const output = yield* boundary({
          toolStatus: () => Effect.succeed({ kind: "recorded", run }),
        })({ action: "status", runId: "old" });
        const contract = decodeWorkflowContract(output.structuredContent);
        if (contract?.action !== "status" || contract.kind !== "recorded")
          throw new Error("Expected recorded status");
        expect(contract.run.finished).toBe(5);
        expect(contract.run.state).toBe(state);
        expect(contract.run.runningIn).toBe(state === "running" ? 777 : undefined);
        for (const field of ["args", "pid", "notified", "result", "logs", "agents", "attention"])
          expect(contract.run).not.toHaveProperty(field);
        expect(contract).not.toHaveProperty("attention");
      }
    }),
  );

  it.effect(
    "returns actual stop state and leaves absent paths absent even for clipped results",
    () =>
      Effect.gen(function* () {
        for (const state of ["stopped", "completed"] as const) {
          const run = workflowRunView({
            state,
            endedAt: 7,
            result: { text: "[truncated", clipped: true },
          });
          const output = yield* boundary({ stop: () => Effect.succeed(run) })({
            action: "stop",
            runId: run.id,
          });
          const contract = decodeWorkflowContract(output.structuredContent);
          if (contract?.action !== "stop") throw new Error("Expected stop");
          expect(contract.run.state).toBe(state);
          expect(contract.run.result).toEqual(run.result);
          for (const field of ["scriptPath", "journalPath", "cleanup", "finished"])
            expect(contract.run).not.toHaveProperty(field);
          expect(contract).not.toHaveProperty("cleanup");
        }
      }),
  );

  it.effect(
    "lists full saved metadata and complete diagnostics independently of name truncation",
    () =>
      Effect.gen(function* () {
        const args = {
          type: "object",
          properties: { exact: { type: "string", pattern: "x".repeat(400) } },
          required: ["exact"],
        };
        const listing: WorkflowListing = {
          ...emptyListing,
          truncated: true,
          workflows: Array.from({ length: 25 }, (_, index) => ({
            name: `saved-${index}`,
            scope: "project",
            path: longPath,
            meta: {
              name: "Declared name",
              description: "Description",
              whenToUse: "When ready",
              phases: [{ title: "Read", agents: [{ label: "reader", profile: "reviewer" }] }],
              args,
            },
          })),
          diagnostics: Array.from({ length: 32 }, (_, index) => ({
            path: longPath,
            message: `diagnostic-${index}`,
          })),
        };
        const run = fullRun();
        const output = yield* boundary(
          { list: Effect.succeed([run]) },
          listing,
        )({ action: "list" });
        const contract = decodeWorkflowContract(output.structuredContent);
        if (contract?.action !== "list") throw new Error("Expected list");
        expect(contract.saved).toEqual(listing);
        expect(contract.runs).toMatchObject([
          {
            id: run.id,
            source: run.source,
            scriptPath: longPath,
            counts: { queued: 29, completed: 1, skipped: 1 },
            planned: 1,
            reused: 2,
            total: 33,
          },
        ]);
        expect(contract.runs[0]).not.toHaveProperty("args");
        args.required.push("later");
        expect(decodeWorkflowContract(output.structuredContent)).toEqual(contract);
        expect(contract.saved.workflows[0]?.meta.args).not.toEqual(args);
        expect(Object.isFrozen(contract.saved.workflows[0]?.meta.args)).toBe(true);
        expect(Object.isFrozen(output.structuredContent)).toBe(true);
      }),
  );

  it.effect(
    "keeps typed failures unstructured and retains admitted receipts on encoding failure",
    () =>
      Effect.gen(function* () {
        for (const error of [
          new WorkflowScriptError({ message: "Invalid script" }),
          new WorkflowRequestError({ code: "resume_unknown", message: "Unknown resume" }),
        ]) {
          const output = yield* boundary({ start: () => Effect.fail(error) })({
            action: "start",
            script: script("return null;"),
          });
          expect(output.isError).toBe(true);
          expect(output.structuredContent).toBeUndefined();
          expect(textOf(output)).toContain(error.message);
        }
        const missing = yield* boundary({
          toolStatus: () => Effect.fail(new WorkflowNotFoundError({ message: "Not found" })),
        })({ action: "status", runId: "missing" });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toBeUndefined();
        const invalid = yield* boundary({})({ action: "start" });
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toBeUndefined();
        let admitted = false;
        const output = yield* boundary({
          start: () =>
            Effect.sync(() => {
              admitted = true;
              return { ...receipt, budget: { total: 100, spent: Number.NaN, refused: 0 } };
            }),
        })({ action: "start", script: script("return null;") });
        expect(admitted).toBe(true);
        expect(output.isError).toBe(true);
        expect(output.structuredContent).toBeUndefined();
        expect(output.details).toMatchObject({
          run: { id: receipt.id },
          issue: { code: "workflow-contract-unavailable" },
        });
        const issues =
          workflowCompactSummary({
            phase: "settled",
            args: { action: "start" },
            result: output,
            context: renderContextFixture(),
          })?.issues ?? [];
        expect(issues).toHaveLength(1);
        expect(issueMessageStyleProblems(issues[0]!.message)).toEqual([]);
        expect(issues[0]?.detail).toContain("may have taken effect");
        expect(textOf(output)).toContain(receipt.id);
        expect(textOf(output)).toContain("may have taken effect");
        expect(textOf(output)).not.toMatch(/SchemaError|Expected|nothing ran|rolled back/);
      }),
  );

  it("strictly rejects unexpected contract fields and redacts diagnostics without clipping recovery", () => {
    const run = fullRun();
    const message = `api_key=sk-abcdefghijklmnopqrstuvwxyz\n${"recovery ".repeat(500)}${longPath}`;
    const value = workflowStatusContract({
      kind: "view",
      run: { ...run, failure: { kind: "sandbox", message, stack: "\u001b[2Jstack" } },
      attention: [{ kind: "question", runId: "agent", writer: true, message }],
    });
    const contract = decodeWorkflowContract(encodeWorkflowContract(value));
    if (contract?.action !== "status" || contract.kind !== "view") throw new Error("Expected view");
    expect(contract.run.failure?.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(contract.run.failure?.message).toContain(longPath);
    expect(contract.run.failure?.stack).toBe("stack");
    expect(decodeWorkflowContract({ ...contract, secret: true })).toBeUndefined();
    expect(
      decodeWorkflowContract({ ...contract, run: { ...contract.run, args: null } }),
    ).toBeUndefined();
    expect(
      decodeWorkflowContract({
        ...contract,
        run: { ...contract.run, result: { value: {}, text: "{}", clipped: false } },
      }),
    ).toBeUndefined();
    expect(
      decodeWorkflowContract({ ...contract, run: { ...contract.run, startedAt: Number.NaN } }),
    ).toBeUndefined();
  });
});
