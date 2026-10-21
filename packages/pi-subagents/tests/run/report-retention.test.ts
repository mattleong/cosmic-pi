import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import { extensionApiFixture, yieldUntil } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  hostNotifier,
  type SubagentCompletionNotification,
  type SubagentNotification,
} from "../../src/boundary/host-notifier.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { sessionReportArchive } from "../../src/boundary/report-archive.ts";
import { SubagentService } from "../../src/run/service.ts";
import {
  MAX_ARCHIVED_REPORT_CHARS,
  MAX_FINAL_TEXT_CHARS,
  unsavedReportNote,
} from "../../src/run/state.ts";
import { awaitContract, readStatusTarget } from "../../src/tools/contract.ts";
import { decodeSubagentContract, encodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import { projectSubagentRunCard } from "../../src/tools/details-projection.ts";
import { awaitResultText } from "../../src/tools/execute-await.ts";
import { MAX_OUTCOME_PREVIEW_CHARS } from "../../src/run/limits.ts";
import { temporaryDirectory } from "../workspace/fixtures/repository.ts";
import {
  acknowledgeCompletions,
  awaitObservations,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";

const findings = (lines: number) =>
  Array.from({ length: lines }, (_, line) => `finding ${line}`).join("\n");

const readFile = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"));

const completedRun = (notification: SubagentNotification | undefined) =>
  notification?.type === "completed" ? notification.runs[0] : undefined;

// The parent-facing completion notice exactly as the root notifier would steer it.
const noticeText = (run: SubagentCompletionNotification | undefined): string => {
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  if (run) hostNotifier(extensionApiFixture({ sendMessage }))({ type: "completed", runs: [run] });
  const content = sendMessage.mock.calls[0]?.[0].content;
  return Predicate.isString(content) ? content : "";
};

describe("report retention", () => {
  it.effect("archives a report longer than the in-memory cap in full and names its size", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { fake, projections, notifications, layer } = localServiceFixture({
        archiveReport: sessionReportArchive(agent, "session-1"),
      });
      const report = findings(12_000);
      expect(report.length).toBeGreaterThan(MAX_FINAL_TEXT_CHARS);
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.settle(report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.finalText?.length).toBeLessThanOrEqual(MAX_FINAL_TEXT_CHARS);
        expect(report.startsWith(completed.finalText?.slice(0, 1_000) ?? "missing")).toBe(true);
        expect(completed.finalTextTruncation).toMatchObject({
          originalChars: report.length,
          originalLines: 12_000,
        });
        expect(projectSubagentRunCard(completed).finalTextTruncated).toBe(true);
        const archive = completed.reportArchive;
        expect(archive?.complete).toBe(true);
        expect(yield* readFile(archive?.path ?? "missing")).toBe(report);

        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length > 0);
        const notified = completedRun(notifications[0]);
        expect(notified?.reportArchive).toEqual(archive);
        expect(notified?.finalTextTruncation?.originalChars).toBe(report.length);
        // The notice hands over the file, never the report body.
        const notice = noticeText(notified);
        expect(notice).toContain(archive?.path ?? "missing");
        expect(notice).not.toContain("finding 0\n");
        expect(notice).not.toContain("finding 11999");
      });
    }).pipe(Effect.scoped),
  );

  it.effect("delivers a long report to agent_await as its file and to agent_read beside it", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { fake, projections, layer } = localServiceFixture({
        archiveReport: sessionReportArchive(agent, "session-1"),
      });
      const report = findings(12_000);
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.settle(report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const read = yield* executeAgentActionEffect(
          { tool: "agent_read", args: { agentIds: [run.id] } },
          { kind: "main" },
        ).pipe(Effect.provideService(SubagentService, service));
        const readContract = decodeSubagentContract("agent_read")(read.structuredContent);
        const [readout] = readContract?.agents ?? [];
        const reportFile = readout?.kind === "run" ? readout.reportFile : undefined;
        expect(reportFile).toMatchObject({ chars: report.length, lines: 12_000, complete: true });
        // agent_read returns the retained start of the report beside its file.
        expect(readout).toMatchObject({ truncated: true });
        expect(readout?.text?.length).toBeLessThanOrEqual(MAX_FINAL_TEXT_CHARS);
        expect(readout?.text).toMatch(/^finding 0\nfinding 1\n/u);
        expect(yield* readFile(reportFile?.path ?? "missing")).toBe(report);
        const readText = read.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        expect(readText.join("\n")).toContain(reportFile?.path);
        expect(readText.join("\n")).toContain("finding 0\n");

        const observations = yield* awaitObservations(service, [run.id]);
        const text = awaitResultText("", observations, []);
        const contract = awaitContract({
          observations,
          until: "all_finished",
          requestedRunIds: [run.id],
        });
        expect(() => encodeSubagentContract(contract)).not.toThrow();
        const [target] = contract.targets;
        expect(target?.report).toEqual({ status: "delivered", ...reportFile });
        expect(text).toContain(reportFile?.path);
        expect(text).not.toContain("finding 0\n");
      });
    }).pipe(Effect.scoped),
  );

  it.effect("previews the report and points to agent_read when the archive can't be written", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      // A file where the archive directory belongs makes every write fail.
      const blocked = path.join(agent, "blocked");
      yield* Effect.promise(() => fs.writeFile(blocked, ""));
      const report = findings(12_000);
      const blockedFixture = () =>
        localServiceFixture({ archiveReport: sessionReportArchive(blocked, "session-1") });

      // One report is awaited and the other reaches its parent as a notice.
      const awaited = blockedFixture();
      yield* withService(awaited.layer, function* (service) {
        const run = yield* service.start(request());
        awaited.fake.controls[0]!.settle(report);
        yield* yieldUntil(() => awaited.projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.reportArchive).toBeUndefined();
        expect(completed.finalTextTruncation?.originalChars).toBe(report.length);
        // agent_read gives the same unsaved report, under the same note, without consuming it.
        const read = yield* executeAgentActionEffect(
          { tool: "agent_read", args: { agentIds: [run.id] } },
          { kind: "main" },
        ).pipe(Effect.provideService(SubagentService, service));
        const [readout] =
          decodeSubagentContract("agent_read")(read.structuredContent)?.agents ?? [];
        expect(readout?.text?.startsWith(unsavedReportNote(completed.finalTextTruncation))).toBe(
          true,
        );
        expect(readout?.text).toContain("finding 0\nfinding 1\n");
        const observations = yield* awaitObservations(service, [run.id]);
        const [target] = awaitContract({
          observations,
          until: "all_finished",
          requestedRunIds: [run.id],
        }).targets;
        const delivered = target?.report;
        expect(delivered && "text" in delivered && delivered.truncated).toBe(true);
        expect(delivered && "text" in delivered && delivered.text.length).toBeLessThanOrEqual(
          MAX_OUTCOME_PREVIEW_CHARS,
        );
        const text = awaitResultText("", observations, []);
        expect(text).toContain("finding 0 finding 1");
        expect(text).toContain("agent_read");
      });

      const notified = blockedFixture();
      yield* withService(notified.layer, function* (service) {
        yield* service.start(request());
        notified.fake.controls[0]!.settle(report);
        yield* yieldUntil(() => notified.projections.at(-1)?.runs[0]?.state === "completed");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notified.notifications.length > 0);
        const notice = completedRun(notified.notifications[0]);
        expect(notice?.reportArchive).toBeUndefined();
        const text = noticeText(notice);
        expect(text).toContain("finding 0 finding 1");
        expect(text).toContain("agent_read");
        expect(text).not.toContain("finding 11999");
        expect(text).not.toContain(blocked);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("hands a nested Pi parent the report's file, not its body", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { fake, projections, notifications, layer } = localServiceFixture({
        archiveReport: sessionReportArchive(agent, "session-1"),
        notify: acknowledgeCompletions,
      });
      const report = findings(3_000);
      yield* withService(layer, function* (service) {
        const parent = yield* service.start(request({ name: "parent" }));
        const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
        fake.controls[1]!.settle(report);
        yield* yieldUntil(
          () => projections.at(-1)?.runs.find((run) => run.id === child.id)?.state === "completed",
        );
        yield* TestClock.adjust("100 millis");
        const notices = () =>
          (fake.controls[0]?.ipc ?? []).flatMap((message) =>
            message.type === "proxy_notification" ? [message.message] : [],
          );
        yield* yieldUntil(() => notices().length > 0);

        const archive = (yield* runView(service, child.id)).reportArchive;
        const [notice] = notices();
        expect(notice).toContain(archive?.path ?? "missing");
        expect(notice).not.toContain("finding 0\n");
        expect(yield* readFile(archive?.path ?? "missing")).toBe(report);
        expect(notifications).toEqual([]);
      });
    }).pipe(Effect.scoped),
  );

  for (const long of [false, true])
    it.effect(
      long
        ? "saves a failure longer than its preview and names its file in the notice"
        : "saves no file for a failure that fits its preview",
      () =>
        Effect.gen(function* () {
          const agent = yield* temporaryDirectory("report-retention-");
          const { fake, projections, notifications, layer } = localServiceFixture({
            archiveReport: sessionReportArchive(agent, "session-1"),
          });
          yield* withService(layer, function* (service) {
            const run = yield* service.start(request());
            fake.controls[0]!.offer({ type: "message_start", message: { role: "assistant" } });
            fake.controls[0]!.offer({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "error",
                errorMessage: `Provider unavailable.${long ? ` ${"detail ".repeat(100)}` : ""}`,
                content: [{ type: "text", text: "Partial work." }],
              },
            });
            fake.controls[0]!.offer({ type: "agent_settled" });
            yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");

            const failed = yield* runView(service, run.id);
            expect((failed.error?.length ?? 0) > MAX_OUTCOME_PREVIEW_CHARS).toBe(long);
            expect(readStatusTarget(failed).errorFile !== undefined).toBe(long);
            yield* TestClock.adjust("100 millis");
            yield* yieldUntil(() => notifications.length > 0);
            const notified = completedRun(notifications[0]);
            expect(notified?.errorArchive).toEqual(failed.errorArchive);
            const notice = noticeText(notified);
            if (!long) {
              expect(failed.errorArchive).toBeUndefined();
              expect(notice).toContain("Provider unavailable.");
              return;
            }
            expect(failed.errorArchive?.path).toContain("failure");
            expect(yield* readFile(failed.errorArchive?.path ?? "missing")).toBe(failed.error);
            expect(notice).toContain(failed.errorArchive?.path ?? "missing");
            expect(notice).not.toContain("detail ".repeat(100));
          });
        }).pipe(Effect.scoped),
    );

  it.effect("completes the run when the archive capability throws", () => {
    const { fake, projections, layer } = localServiceFixture({
      archiveReport: () => {
        throw new Error("archive host failed");
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      fake.controls[0]!.settle("Short report.");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const completed = yield* runView(service, run.id);
      expect(completed).toMatchObject({ state: "completed", finalText: "Short report." });
      expect(completed.reportArchive).toBeUndefined();
      expect(completed.finalTextTruncation).toBeUndefined();
    });
  });

  it.effect("archives only up to the raw-text cap and marks the copy incomplete", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { fake, projections, layer } = localServiceFixture({
        archiveReport: sessionReportArchive(agent, "session-1"),
      });
      const report = findings(110_000);
      expect(report.length).toBeGreaterThan(MAX_ARCHIVED_REPORT_CHARS);
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.settle(report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.finalTextTruncation?.originalChars).toBe(report.length);
        expect(completed.reportArchive?.complete).toBe(false);
        const saved = yield* readFile(completed.reportArchive?.path ?? "missing");
        expect(saved.startsWith(report.slice(0, MAX_ARCHIVED_REPORT_CHARS))).toBe(true);
        expect(saved).not.toContain("finding 109999");
        expect(saved.length).toBeLessThan(MAX_ARCHIVED_REPORT_CHARS + 1_000);

        const [target] = awaitContract({
          observations: yield* awaitObservations(service, [run.id]),
          until: "all_finished",
          requestedRunIds: [run.id],
        }).targets;
        expect(target?.report).toMatchObject({
          status: "delivered",
          path: completed.reportArchive?.path,
          complete: false,
        });
      });
    }).pipe(Effect.scoped),
  );

  it.effect("archives a runtime-submitted report longer than the in-memory cap whole", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { backend, projections, layer } = nativeReportServiceFixture(undefined, {
        archiveReport: sessionReportArchive(agent, "session-1"),
      });
      const report = `${findings(20_000)}!`;
      expect(report.length).toBeGreaterThan(MAX_FINAL_TEXT_CHARS);
      yield* withService(layer, function* (service) {
        const run = yield* service.start(nativeReportRequest());
        backend.controls[0]?.report(run.id, 1, "long-report", report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.finalText?.length).toBeLessThanOrEqual(MAX_FINAL_TEXT_CHARS);
        expect(completed.finalTextTruncation?.originalChars).toBe(report.length);
        expect(completed.reportArchive?.complete).toBe(true);
        expect(yield* readFile(completed.reportArchive?.path ?? "missing")).toBe(report);
      });
    }).pipe(Effect.scoped),
  );
});
