import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as NativeCrypto from "pi-cosmic-core/platform/native-crypto";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import { nodeFsPromises as fs, nodePath as path } from "./support/node-builtins.ts";
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
import * as Arr from "effect/Array";
import * as Str from "effect/String";

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
  it.effect("delivers a long report as its private file and keeps the body out of the notice", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const notify = hostNotifier(extensionApiFixture({ sendMessage }));
      const report = Arr.join(
        Array.from({ length: 2_000 }, (_, line) => `finding ${line}`),
        "\n",
      );
      const reportArchive = yield* archive.save({ id: "agent-1", generation: 2, text: report });

      notify({
        type: "completed",
        runs: [
          {
            id: "agent-1",
            name: "reader",
            generation: 2,
            outcome: "completed",
            // The run retains only the start of a report this long.
            finalText: Fn.pipe(report, Str.slice(0, MAX_FINAL_TEXT_CHARS)),
            finalTextTruncation: {
              retainedChars: MAX_FINAL_TEXT_CHARS,
              originalChars: report.length,
              originalLines: 2_000,
            },
            reportArchive,
          },
        ],
      });

      const text = sentText(sendMessage);
      expect(text).not.toContain("finding 0");
      expect(text).not.toContain("finding 1999");
      expect(reportArchive.chars).toBe(report.length);
      expect(reportArchive.lines).toBe(2_000);
      expect(reportArchive.complete).toBe(true);
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
      const spaced = yield* sessionReportArchive(agent, "session-1")
        .save({ id: "agent-1", generation: 1, text: "report" })
        .pipe(Effect.flip);
      expect(spaced.reason).toBe("path_unrepresentable");
      expect(yield* exists(reportArchiveRoot(agent))).toBe(false);
      // Each run's model-facing block has room for a path of bounded length only.
      const deep = path.join(
        yield* temporaryAgent,
        Fn.pipe("d", Str.repeat(MAX_OUTCOME_FILE_PATH_CHARS)),
      );
      const long = yield* sessionReportArchive(deep, "session-1")
        .save({ id: "agent-1", generation: 1, text: "report" })
        .pipe(Effect.flip);
      expect(long.reason).toBe("path_unrepresentable");
    }).pipe(Effect.scoped),
  );

  it("previews a report without a file, keeping its actions and pointing to agent_read", () => {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const report = Fn.pipe("r", Str.repeat(MAX_FINAL_TEXT_CHARS));
    const warning = Fn.pipe("Check the migration before merging.", Str.repeat(200));
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
        },
      ],
    });

    const text = sentText(sendMessage);
    expect(text.length).toBeLessThanOrEqual(MAX_RUN_BLOCK_CHARS + 200);
    expect(text).toContain("Check the migration before merging.");
    expect(text).toContain(Fn.pipe("r", Str.repeat(100)));
    expect(text).not.toContain(Fn.pipe("r", Str.repeat(1_000)));
    expect(text).toContain("agent_read");
  });

  it.effect("saves a failure only when it is longer than its preview", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const failure = `Build failed.\n${Fn.pipe("detail ", Str.repeat(500))}`;
      const saved = yield* archive.save({
        id: "agent-1",
        generation: 1,
        kind: "failure",
        text: failure,
      });
      expect(saved.path).toContain("failure");
      expect(yield* Effect.promise(() => fs.readFile(saved.path, "utf8"))).toBe(failure);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves earlier links when an archive owner or a delivery is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const entry = { id: "agent-0000000001", generation: 1, text: "original" };
      const original = yield* archive.save(entry);
      const repeated = yield* archive.save({ ...entry, text: "repeated" });
      const replacement = yield* sessionReportArchive(agent, "session-1").save({
        ...entry,
        text: "replacement owner",
      });

      expect(new Set([original.path, repeated.path, replacement.path]).size).toBe(3);
      expect(yield* Effect.promise(() => fs.readFile(original.path, "utf8"))).toBe("original");
      expect(yield* Effect.promise(() => fs.readFile(repeated.path, "utf8"))).toBe("repeated");
      expect(yield* Effect.promise(() => fs.readFile(replacement.path, "utf8"))).toBe(
        "replacement owner",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed on an archive collision without changing the historical file", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const uuid = vi
        .spyOn(NativeCrypto, "synchronousRandomUuid")
        .mockReturnValue("fixed-archive-identity");
      try {
        const original = yield* archive.save({
          id: "agent-0000000001",
          generation: 1,
          text: "original secret",
        });
        const collision = yield* archive
          .save({ id: "agent-0000000001", generation: 1, text: "replacement" })
          .pipe(Effect.flip);
        expect(collision.reason).toBe("file_exists");
        expect(yield* Effect.promise(() => fs.readFile(original.path, "utf8"))).toBe(
          "original secret",
        );
      } finally {
        uuid.mockRestore();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("fails the save and removes the file when closing reports a deferred write error", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const open = fs.open.bind(fs);
      const opened = vi.spyOn(fs, "open").mockImplementation((...args) =>
        open(...args).then((handle) => {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(() =>
            close().then(() => {
              throw Object.assign(new Error("deferred write failure"), { code: "EIO" });
            }),
          );
          return handle;
        }),
      );
      const failure = yield* archive
        .save({ id: "agent-1", generation: 1, text: "report" })
        .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => opened.mockRestore())));

      expect(failure.reason).toBe("write_failed");
      const directory = path.join(reportArchiveRoot(agent), "session-1");
      expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("says in the file itself when a report exceeded the archive cap", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const whole = yield* archive.save({
        id: "agent-1",
        generation: 1,
        text: "whole",
        originalChars: 5,
      });
      const bounded = yield* archive.save({
        id: "agent-1",
        generation: 2,
        text: "start",
        originalChars: 9_000,
      });

      expect(whole.complete).toBe(true);
      expect(yield* Effect.promise(() => fs.readFile(whole.path, "utf8"))).toBe("whole");
      expect(bounded.complete).toBe(false);
      const saved = yield* Effect.promise(() => fs.readFile(bounded.path, "utf8"));
      expect(Fn.pipe(saved, Str.startsWith("start"))).toBe(true);
      // The file itself says it was cut, beyond the text it keeps.
      expect(saved.length).toBeGreaterThan("start".length);
    }).pipe(Effect.scoped),
  );

  it.live("prunes the oldest unique report files beyond the aggregate size cap", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = sessionReportArchive(agent, "session-1");
      const older = yield* archive.save({ id: "agent-1", generation: 1, text: "older" });
      const newer = yield* archive.save({ id: "agent-1", generation: 1, text: "newer" });
      yield* Effect.promise(() => fs.truncate(older.path, 64 * 1024 * 1024));
      const now = yield* Clock.currentTimeMillis;
      const yesterday = (now - 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => fs.utimes(older.path, yesterday, yesterday));

      yield* pruneReportArchive(agent);

      expect(yield* exists(older.path)).toBe(false);
      expect(yield* Effect.promise(() => fs.readFile(newer.path, "utf8"))).toBe("newer");
    }).pipe(Effect.scoped),
  );

  it.live("keeps pruning past unreadable entries and removes emptied session directories", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const expired = yield* sessionReportArchive(agent, "session-1").save({
        id: "agent-1",
        generation: 1,
        text: "old",
      });
      const fresh = yield* sessionReportArchive(agent, "session-2").save({
        id: "agent-2",
        generation: 1,
        text: "fresh",
      });
      const dangling = path.join(reportArchiveRoot(agent), "session-2", "dangling.md");
      yield* Effect.promise(() => fs.symlink(path.join(agent, "missing"), dangling));
      const now = yield* Clock.currentTimeMillis;
      const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => fs.utimes(expired.path, eightDaysAgo, eightDaysAgo));

      yield* pruneReportArchive(agent);

      expect(yield* exists(expired.path)).toBe(false);
      expect(yield* exists(path.dirname(expired.path))).toBe(false);
      expect(yield* exists(fresh.path)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
