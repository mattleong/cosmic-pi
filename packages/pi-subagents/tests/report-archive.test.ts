import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Core from "pi-cosmic-core";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import { nodeFsPromises as fs, nodePath as path } from "../src/boundary/node-builtins.ts";
import {
  sessionReportArchive,
  pruneReportArchive,
  reportArchiveRoot,
} from "../src/boundary/report-archive.ts";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { MAX_OUTCOME_FILE_PATH_CHARS } from "../src/run/limits.ts";
import { MAX_FINAL_TEXT_CHARS } from "../src/run/state.ts";
import { MAX_RUN_BLOCK_CHARS } from "../src/tools/run-block.ts";
import { temporaryDirectory } from "./workspace/fixtures/repository.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const temporaryAgent = temporaryDirectory("report-archive-");

const sentText = (sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>) => {
  const content = sendMessage.mock.calls[0]?.[0].content;
  return Predicate.isString(content) ? content : "";
};

const exists = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  );

describe("subagent report archive", () => {
  it.effect("delivers a report as its private file and keeps the body out of the notice", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const notify = hostNotifier(extensionApiFixture({ sendMessage }));
      const report = Array.from({ length: 2_000 }, (_, line) => `finding ${line}`).join("\n");
      const reportArchive = archive({ id: "agent-1", generation: 2, text: report });

      notify({
        type: "completed",
        runs: [
          {
            id: "agent-1",
            name: "reader",
            generation: 2,
            outcome: "completed",
            finalText: report,
            reportArchive,
          },
        ],
      });

      const text = sentText(sendMessage);
      expect(text).not.toContain("finding 0");
      expect(text).not.toContain("finding 1999");
      expect(reportArchive?.chars).toBe(report.length);
      expect(reportArchive?.lines).toBe(2_000);
      expect(reportArchive?.complete).toBe(true);
      const directory = path.join(reportArchiveRoot(agent), "session-1");
      const files = yield* Effect.promise(() => fs.readdir(directory));
      expect(files).toHaveLength(1);
      const file = path.join(directory, files[0] ?? "missing");
      expect(text).toContain(file);
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(report);
      expect((yield* Effect.promise(() => fs.stat(file))).mode & 0o777).toBe(0o600);
      expect((yield* Effect.promise(() => fs.stat(directory))).mode & 0o777).toBe(0o700);
    }).pipe(Effect.scoped),
  );

  it.effect("saves nothing under a path that a report reference can't name verbatim", () =>
    Effect.gen(function* () {
      const agent = path.join(yield* temporaryAgent, "two  spaces");
      expect(
        sessionReportArchive(agent, "session-1")({ id: "agent-1", generation: 1, text: "report" }),
      ).toBeUndefined();
      expect(yield* exists(reportArchiveRoot(agent))).toBe(false);
      // Each run's model-facing block has room for a path of bounded length only.
      const deep = path.join(yield* temporaryAgent, "d".repeat(MAX_OUTCOME_FILE_PATH_CHARS));
      expect(
        sessionReportArchive(deep, "session-1")({ id: "agent-1", generation: 1, text: "report" }),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it("previews a report without a file, keeping its actions and pointing to agent_read", () => {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const report = "r".repeat(MAX_FINAL_TEXT_CHARS);
    const warning = "Check the migration before merging.".repeat(200);
    hostNotifier(extensionApiFixture({ sendMessage }))({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "completed",
          finalText: report,
          finalTextTruncation: {
            retainedChars: report.length,
            originalChars: 90_000,
            originalLines: 1,
          },
          warning,
          resumedBy: 'agent-r1-2 "planner"',
        },
      ],
    });

    const text = sentText(sendMessage);
    expect(text.length).toBeLessThanOrEqual(MAX_RUN_BLOCK_CHARS + 200);
    expect(text).toContain("Check the migration before merging.");
    expect(text).toContain("planner");
    expect(text).toContain("r".repeat(100));
    expect(text).not.toContain("r".repeat(1_000));
    expect(text).toContain("agent_read");
  });

  it.effect("saves a failure only when it is longer than its preview", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const failure = `Build failed.\n${"detail ".repeat(500)}`;
      const saved = archive({ id: "agent-1", generation: 1, kind: "failure", text: failure });
      expect(saved?.path).toContain("failure");
      expect(yield* Effect.promise(() => fs.readFile(saved?.path ?? "missing", "utf8"))).toBe(
        failure,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("preserves earlier links when an archive owner or a delivery is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const entry = { id: "agent-r1-1", generation: 1, text: "original" };
      const original = archive(entry);
      const repeated = archive({ ...entry, text: "repeated" });
      const replacement = sessionReportArchive(
        agent,
        "session-1",
      )({
        ...entry,
        text: "replacement owner",
      });
      if (!original || !repeated || !replacement) return yield* Effect.die("archive write failed");

      expect(new Set([original.path, repeated.path, replacement.path]).size).toBe(3);
      expect(yield* Effect.promise(() => fs.readFile(original.path, "utf8"))).toBe("original");
      expect(yield* Effect.promise(() => fs.readFile(repeated.path, "utf8"))).toBe("repeated");
      expect(yield* Effect.promise(() => fs.readFile(replacement.path, "utf8"))).toBe(
        "replacement owner",
      );
      return undefined;
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed on an archive collision without changing the historical file", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const uuid = vi
        .spyOn(Core, "synchronousRandomUuid")
        .mockReturnValue("fixed-archive-identity");
      try {
        const original = archive({ id: "agent-r1-1", generation: 1, text: "original secret" });
        if (!original) return yield* Effect.die("archive write failed");
        expect(archive({ id: "agent-r1-1", generation: 1, text: "replacement" })).toBeUndefined();
        expect(yield* Effect.promise(() => fs.readFile(original.path, "utf8"))).toBe(
          "original secret",
        );
      } finally {
        uuid.mockRestore();
      }
      return undefined;
    }).pipe(Effect.scoped),
  );

  it.effect("says in the file itself when a report exceeded the archive cap", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const whole = archive({ id: "agent-1", generation: 1, text: "whole", originalChars: 5 });
      const bounded = archive({
        id: "agent-1",
        generation: 2,
        text: "start",
        originalChars: 9_000,
      });
      if (!whole || !bounded) return yield* Effect.die("archive write failed");

      expect(whole.complete).toBe(true);
      expect(yield* Effect.promise(() => fs.readFile(whole.path, "utf8"))).toBe("whole");
      expect(bounded.complete).toBe(false);
      const saved = yield* Effect.promise(() => fs.readFile(bounded.path, "utf8"));
      expect(saved.startsWith("start")).toBe(true);
      // The file itself says it was cut, beyond the text it keeps.
      expect(saved.length).toBeGreaterThan("start".length);
      return undefined;
    }).pipe(Effect.scoped),
  );

  it.live("prunes the oldest unique report files beyond the aggregate size cap", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const older = archive({ id: "agent-1", generation: 1, text: "older" });
      const newer = archive({ id: "agent-1", generation: 1, text: "newer" });
      if (!older || !newer) return yield* Effect.die("archive write failed");
      yield* Effect.promise(() => fs.truncate(older.path, 64 * 1024 * 1024));
      const now = yield* Clock.currentTimeMillis;
      const yesterday = (now - 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => fs.utimes(older.path, yesterday, yesterday));

      yield* pruneReportArchive(agent);

      expect(yield* exists(older.path)).toBe(false);
      expect(yield* Effect.promise(() => fs.readFile(newer.path, "utf8"))).toBe("newer");
      return undefined;
    }).pipe(Effect.scoped),
  );

  it.live("keeps pruning past unreadable entries and removes emptied session directories", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const expired = sessionReportArchive(
        agent,
        "session-1",
      )({
        id: "agent-1",
        generation: 1,
        text: "old",
      });
      const fresh = sessionReportArchive(
        agent,
        "session-2",
      )({
        id: "agent-2",
        generation: 1,
        text: "fresh",
      });
      if (!expired || !fresh) return yield* Effect.die("archive write failed");
      const dangling = path.join(reportArchiveRoot(agent), "session-2", "dangling.md");
      yield* Effect.promise(() => fs.symlink(path.join(agent, "missing"), dangling));
      const now = yield* Clock.currentTimeMillis;
      const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => fs.utimes(expired.path, eightDaysAgo, eightDaysAgo));

      yield* pruneReportArchive(agent);

      expect(yield* exists(expired.path)).toBe(false);
      expect(yield* exists(path.dirname(expired.path))).toBe(false);
      expect(yield* exists(fresh.path)).toBe(true);
      return undefined;
    }).pipe(Effect.scoped),
  );
});
