import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { normalizeRpcEvent } from "../../src/backend/local-pi-events.ts";
import type { ReportArchiveEntry } from "../../src/boundary/report-archive.ts";
import { backendEventHandler } from "../../src/run/events.ts";
import type { CompletionGenerationRecord } from "../../src/run/internal.ts";
import { MAX_UNRESOLVED_REPORT_GENERATIONS } from "../../src/run/limits.ts";
import { emptyUsage } from "../../src/run/model.ts";
import type { RunNotificationDelivery } from "../../src/run/notification-delivery.ts";
import { settlementOperations } from "../../src/run/settlement.ts";
import {
  boundOutputText,
  MAX_ARCHIVED_REPORT_CHARS,
  MAX_FINAL_TEXT_CHARS,
} from "../../src/run/state.ts";
import { view } from "../fixtures/run-view.ts";
import {
  makeRunContext,
  makeTestSettlement,
  runningAssignment,
  runRecordFixture,
} from "./fixtures/run-context.ts";

const findings = (lines: number) =>
  Array.from({ length: lines }, (_, line) => `finding ${line}`).join("\n");

const messageEnd = (text: string) => ({
  type: "message_end" as const,
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

const quietDelivery: RunNotificationDelivery = {
  deliverPendingCompletions: Effect.void,
  queueActionNotificationLocked: () => undefined,
  insertCompletionLocked: () => undefined,
  wakeCompletionLocked: () => undefined,
  discardQuestionLocked: () => undefined,
};

describe("report capture", () => {
  it.effect("keeps a long Pi message past the in-memory cap, up to the archive cap", () =>
    Effect.gen(function* () {
      const long = findings(12_000);
      expect(long.length).toBeGreaterThan(MAX_FINAL_TEXT_CHARS);
      const kept = yield* normalizeRpcEvent(messageEnd(long), 1);
      expect(kept).toMatchObject({
        type: "assistant_message",
        text: long,
        terminal: { text: long },
      });
      expect(kept?.type === "assistant_message" && kept.originalSize).toBeFalsy();

      const huge = findings(110_000);
      expect(huge.length).toBeGreaterThan(MAX_ARCHIVED_REPORT_CHARS);
      const bounded = yield* normalizeRpcEvent(messageEnd(huge), 1);
      if (bounded?.type !== "assistant_message") return yield* Effect.die("expected a message");
      expect(bounded.terminal?.text?.length).toBe(MAX_ARCHIVED_REPORT_CHARS);
      expect(bounded.terminal?.originalSize).toEqual({ chars: huge.length, lines: 110_000 });
      expect(bounded.originalSize).toEqual(bounded.terminal?.originalSize);
      return undefined;
    }),
  );

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
        usage: emptyUsage(),
      });

      expect(record.latestAssistantFullText).toBeUndefined();
      expect(record.latestAssistantText?.length).toBeLessThanOrEqual(MAX_FINAL_TEXT_CHARS);
      expect(record.latestAssistantTruncation?.originalChars).toBe(originalSize?.chars);
    }).pipe(Effect.scoped),
  );

  it.effect("archives a report only under the generation that delivers it", () =>
    Effect.gen(function* () {
      const archived: ReportArchiveEntry[] = [];
      const context = yield* makeRunContext();
      const settlement = settlementOperations({
        ...context,
        delivery: quietDelivery,
        closeRecordScope: () => Effect.void,
        claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
        archiveReport: (entry) => {
          archived.push(entry);
          return {
            path: `/archive/${entry.generation}.md`,
            chars: entry.text.length,
            lines: 1,
            complete: true,
          };
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
      expect(archived.map((entry) => entry.generation)).toEqual([admitted.completionGeneration]);
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
    }).pipe(Effect.scoped),
  );
});
