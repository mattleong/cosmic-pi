import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentProjection } from "../../src/run/model.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import {
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  runView,
  withService,
} from "./fixtures/service-harness.ts";

const latest = (projections: ReadonlyArray<SubagentProjection>) => projections.at(-1)?.runs[0];

const readRun = (id: string) =>
  executeAgentActionEffect({ tool: "agent_read", args: { agentIds: [id] } }, { kind: "main" });

// The structured status agent_read returns for the run.
const readWarnings = (id: string) =>
  readRun(id).pipe(
    Effect.map((result) => {
      const [read] = decodeSubagentContract("agent_read")(result.structuredContent)?.agents ?? [];
      return read?.kind === "run" ? read.status.warnings : undefined;
    }),
  );

describe("run warnings", () => {
  it.effect("keeps an assignment's child and system warnings until the next assignment", () => {
    // A paused native run resumes in the same process, which can still emit the earlier
    // assignment's events.
    const backend = fakeNativeReportBackendLayer({
      capabilities: ["steer", "interrupt", "resume"],
    });
    const { projections, notifications, layer } = nativeReportServiceFixture(backend);
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest({ name: "warned" }));
      const control = backend.controls[0]!;
      const contact = (assignmentEpoch: number, kind: "progress" | "warning", message: string) =>
        control.offer({
          type: "supervisor_contact",
          assignmentEpoch,
          requestId: `${kind}-${assignmentEpoch}-${message.length}`,
          kind,
          message,
        });

      contact(1, "warning", "Disk is nearly full.");
      control.offer({ type: "warning", message: "Extension failed to load." });
      yield* yieldUntil(() => latest(projections)?.systemWarning !== undefined);
      expect(yield* runView(service, run.id)).toMatchObject({
        childWarning: "Disk is nearly full.",
        systemWarning: "Extension failed to load.",
      });
      expect(yield* readWarnings(run.id)).toEqual([
        { source: "child", message: "Disk is nearly full." },
        { source: "system", message: "Extension failed to load." },
      ]);

      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      const resumed = yield* service.resume(run.id, "Continue.");
      expect(resumed.assignmentEpoch).toBe(2);
      expect(resumed.childWarning).toBeUndefined();
      expect(resumed.systemWarning).toBeUndefined();
      expect(yield* readWarnings(run.id)).toEqual([]);

      // The later progress shows the earlier assignment's warning was handled first.
      contact(1, "warning", "Stale warning.");
      contact(2, "progress", "Halfway.");
      yield* yieldUntil(() => latest(projections)?.progress === "Halfway.");
      expect((yield* runView(service, run.id)).childWarning).toBeUndefined();

      contact(2, "warning", "Tests are flaky.");
      control.offer({ type: "warning", message: "Guidance is unconfirmed." });
      yield* yieldUntil(() => latest(projections)?.systemWarning !== undefined);
      control.report(run.id, 1, "report-2", "Done.");
      yield* yieldUntil(() => latest(projections)?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.some((notice) => notice.type === "completed"));
      const completed = notifications.find((notice) => notice.type === "completed");
      const folded = completed?.type === "completed" ? completed.runs[0]?.warning : undefined;
      expect(folded).toContain("Tests are flaky.");
      expect(folded).toContain("Guidance is unconfirmed.");
      expect(folded).not.toContain("Stale warning.");
    });
  });

  it.effect("shows identical child and system warnings once, under the latest source", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(nativeReportRequest({ name: "repeated" }));
      const warning = "The report was rejected.";
      backend.controls[0]!.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "warning-1",
        kind: "warning",
        message: warning,
      });
      backend.controls[0]!.offer({ type: "warning", message: warning });
      yield* yieldUntil(() => latest(projections)?.systemWarning === warning);

      expect(yield* readWarnings(run.id)).toEqual([{ source: "system", message: warning }]);
      const text = (yield* readRun(run.id)).content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      expect(text.split(warning)).toHaveLength(2);
    });
  });
});
