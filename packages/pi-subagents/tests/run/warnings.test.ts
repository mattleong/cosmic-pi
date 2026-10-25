import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentProjection } from "../../src/run/model.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import { MAX_CONTACT_TEXT_CHARS } from "../../src/run/limits.ts";
import {
  contactParentFrame,
  fakeEventBackendLayer,
  localServiceFixture,
  eventBackendRequest,
  eventBackendServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

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
    const backend = fakeEventBackendLayer({
      capabilities: ["steer", "interrupt", "resume"],
    });
    const { projections, notifications, layer } = eventBackendServiceFixture(backend);
    return withService(layer, function* (service) {
      const run = yield* service.start(eventBackendRequest({ name: "warned" }));
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
      control.offer({ type: "warning", message: "Extension reloaded." });
      yield* yieldUntil(() => latest(projections)?.systemWarning !== undefined);
      control.complete("Done.");
      yield* yieldUntil(() => latest(projections)?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => Arr.some(notifications, (notice) => notice.type === "completed"));
      const completed = Option.getOrUndefined(
        Arr.findFirst(notifications, (notice) => notice.type === "completed"),
      );
      const folded = completed?.type === "completed" ? completed.runs[0]?.warning : undefined;
      expect(folded).toContain("Tests are flaky.");
      expect(folded).toContain("Extension reloaded.");
      expect(folded).not.toContain("Stale warning.");
    });
  });

  it.effect("shows identical child and system warnings once, under the latest source", () => {
    const { backend, projections, layer } = eventBackendServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(eventBackendRequest({ name: "repeated" }));
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
      const text = Arr.join(
        Arr.map((yield* readRun(run.id)).content, (part) =>
          part.type === "text" ? part.text : "",
        ),
        "",
      );
      expect(Str.split(text, warning)).toHaveLength(2);
    });
  });

  it.effect("cuts an oversized warning from any runtime to its start, naming its size", () => {
    const warning = `Start of the warning. ${Fn.pipe("w", Str.repeat(40_000))}`;
    const cutOf = `of ${warning.length.toLocaleString("en-US")} characters`;
    const pi = localServiceFixture();
    const native = eventBackendServiceFixture();
    const retained = (projections: ReadonlyArray<SubagentProjection>) => {
      const kept = latest(projections)?.childWarning ?? "";
      expect(kept.length).toBeLessThanOrEqual(MAX_CONTACT_TEXT_CHARS);
      expect(Fn.pipe(kept, Str.startsWith("Start of the warning."))).toBe(true);
      expect(kept).toContain(cutOf);
    };
    return Effect.gen(function* () {
      yield* withService(pi.layer, function* (service) {
        yield* service.start(request({ name: "pi-warned" }));
        pi.fake.controls[0]?.offerIpc(contactParentFrame("long", "warning", warning));
        yield* yieldUntil(() => latest(pi.projections)?.childWarning !== undefined);
        retained(pi.projections);
      });
      yield* withService(native.layer, function* (service) {
        yield* service.start(eventBackendRequest({ name: "native-warned" }));
        native.backend.controls[0]?.offer({
          type: "supervisor_contact",
          assignmentEpoch: 1,
          requestId: "long",
          kind: "warning",
          message: warning,
        });
        yield* yieldUntil(() => latest(native.projections)?.childWarning !== undefined);
        retained(native.projections);
      });
    });
  });
});
