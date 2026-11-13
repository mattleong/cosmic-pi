import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ReportArchiveEntry } from "../../src/boundary/report-archive.ts";
import { backendEventHandler } from "../../src/run/events.ts";
import type { CompletionGenerationRecord } from "../../src/run/internal.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "../../src/run/limits.ts";
import { boundOutputText, MAX_FINAL_TEXT_CHARS } from "../../src/run/state.ts";
import { view } from "../fixtures/run-view.ts";
import {
  findings,
  makeRunContext,
  makeTestSettlement,
  runningAssignment,
  runRecordFixture,
  quietDelivery,
  testSettlement,
} from "./fixtures/run-context.ts";
import * as Arr from "effect/Array";

describe("report capture", () => {
  it.effect("keeps no full copy of a late message that arrives after a pause", () =>
    Effect.gen(function* () {
      const settlement = yield* makeTestSettlement();
      const record = yield* runRecordFixture({
        view: view({ state: "paused" }),
        assignment: runningAssignment(1),
        pausedAssignmentEpoch: 1,
      });
      const handleEvent = backendEventHandler({
        settlement,
        queueQuestionLocked: () => undefined,
        onProxyEvent: () => Effect.void,
      });
      const { text, originalSize } = boundOutputText(findings(110_000));

      yield* handleEvent(record, {
        type: "assistant_message",
        assignmentEpoch: 1,
        text,
        ...(originalSize && { originalSize }),
      });

      expect(record.latestAssistantFullText).toBeUndefined();
      expect(record.latestAssistantText?.length).toBeLessThanOrEqual(MAX_FINAL_TEXT_CHARS);
      expect(record.latestAssistantTruncation?.originalChars).toBe(originalSize?.chars);
    }),
  );

  it.effect("archives a report only under the generation that delivers it", () =>
    Effect.gen(function* () {
      const archived: ReportArchiveEntry[] = [];
      const context = yield* makeRunContext();
      const settlement = testSettlement(context, {
        delivery: quietDelivery,
        archiveReport: {
          save: (entry) =>
            Effect.sync(() => {
              archived.push(entry);
              return {
                path: `/archive/${entry.generation}.md`,
                chars: entry.text.length,
                lines: 1,
                complete: true,
              };
            }),
          discard: () => Effect.void,
        },
      });
      const settle = (completionGenerations: Map<number, CompletionGenerationRecord>) =>
        Effect.gen(function* () {
          const record = yield* runRecordFixture({
            view: view({ state: "running" }),
            assignment: runningAssignment(1),
            completionGenerations,
            completionGeneration: completionGenerations.size,
          });
          const text = findings(12_000);
          yield* settlement.runSettledFromBackend(record, 1, { stopReason: "stop", text });
          return record;
        });

      const admitted = yield* settle(new Map());
      expect(admitted.view.state).toBe("completed");
      expect(Arr.map(archived, (entry) => entry.generation)).toEqual([
        admitted.completionGeneration,
      ]);
      expect(admitted.view.reportArchive).toBeDefined();
      expect(admitted.latestAssistantFullText).toBeUndefined();

      // A full outbox queues no new generation, so nothing is archived under a guessed one.
      const full = new Map(
        Array.from({ length: MAX_UNRESOLVED_REPORT_GENERATIONS }, (_, index) => [
          index + 1,
          { generation: index + 1, outcome: "completed" as const, finalText: "older" },
        ]),
      );
      const refused = yield* settle(full);
      expect(refused.view.state).toBe("completed");
      expect(archived).toHaveLength(1);
      expect(refused.view.reportArchive).toBeUndefined();
      expect(refused.view.finalTextTruncation).toBeDefined();
      expect(refused.latestAssistantFullText).toBeUndefined();
    }),
  );
});
