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
import { MAX_ARCHIVED_REPORT_CHARS, MAX_FINAL_TEXT_CHARS } from "../../src/run/state.ts";
import { awaitContract } from "../../src/tools/contract.ts";
import { decodeSubagentContract, encodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import { projectSubagentRunCard } from "../../src/tools/details-projection.ts";
import { formatDetailedRuns } from "../../src/tools/format.ts";
import { temporaryDirectory } from "../workspace/fixtures/repository.ts";
import {
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
        const notice = noticeText(notified);
        expect(notice).toContain(archive?.path ?? "missing");
        expect(notice).not.toContain("finding 11999");
      });
    }).pipe(Effect.scoped),
  );

  it.effect("tells agent_await and agent_read that capture cut the report, and where it is", () =>
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
        expect(readout?.truncated).toBe(true);
        const archivePath =
          readout?.kind === "run" ? readout.status.reportArchive?.path : undefined;
        expect(archivePath).toBeDefined();
        expect(yield* readFile(archivePath ?? "missing")).toBe(report);
        const readText = read.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        expect(readText.join("\n")).toContain(archivePath);

        const observations = yield* awaitObservations(service, [run.id]);
        const formatted = formatDetailedRuns(observations.map((observation) => observation.run));
        const contract = awaitContract({
          observations,
          fullyRenderedIds: formatted.fullyRenderedIds,
          until: "all_finished",
          requestedRunIds: [run.id],
        });
        expect(() => encodeSubagentContract(contract)).not.toThrow();
        const [target] = contract.targets;
        // The retained report still fits one await, so it's delivered rather than deferred.
        expect(target?.report.status).toBe("delivered");
        expect(target?.reportTruncation).toMatchObject({
          originalChars: report.length,
          originalLines: 12_000,
        });
        expect(target?.reportArchive).toMatchObject({ path: archivePath, complete: true });
        expect(formatted.text).toContain(archivePath);
      });
    }).pipe(Effect.scoped),
  );

  it.effect("delivers the retained report inline when the archive can't be written", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      // A file where the archive directory belongs makes every write fail.
      const blocked = path.join(agent, "blocked");
      yield* Effect.promise(() => fs.writeFile(blocked, ""));
      const { fake, projections, notifications, layer } = localServiceFixture({
        archiveReport: sessionReportArchive(blocked, "session-1"),
      });
      const report = findings(12_000);
      yield* withService(layer, function* (service) {
        const run = yield* service.start(request());
        fake.controls[0]!.settle(report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.reportArchive).toBeUndefined();
        expect(completed.finalTextTruncation?.originalChars).toBe(report.length);

        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length > 0);
        const notified = completedRun(notifications[0]);
        expect(notified?.reportArchive).toBeUndefined();
        expect(notified?.finalTextTruncation?.originalChars).toBe(report.length);
        const notice = noticeText(notified);
        expect(notice).toContain("finding 0\nfinding 1\n");
        expect(notice).not.toContain(blocked);

        const observations = yield* awaitObservations(service, [run.id]);
        const [target] = awaitContract({
          observations,
          fullyRenderedIds: new Set([run.id]),
          until: "all_finished",
          requestedRunIds: [run.id],
        }).targets;
        expect(target?.reportTruncation?.originalChars).toBe(report.length);
        expect(target?.reportArchive).toBeUndefined();
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
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps and archives a runtime-submitted report up to the in-memory cap whole", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("report-retention-");
      const { backend, projections, layer } = nativeReportServiceFixture(undefined, {
        archiveReport: sessionReportArchive(agent, "session-1"),
      });
      const report = `${findings(10_000).slice(0, MAX_FINAL_TEXT_CHARS - 1)}!`;
      yield* withService(layer, function* (service) {
        const run = yield* service.start(nativeReportRequest());
        backend.controls[0]?.report(run.id, 1, "full-cap", report);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

        const completed = yield* runView(service, run.id);
        expect(completed.finalText).toBe(report);
        expect(completed.finalTextTruncation).toBeUndefined();
        expect(yield* readFile(completed.reportArchive?.path ?? "missing")).toBe(report);
      });
    }).pipe(Effect.scoped),
  );
});
