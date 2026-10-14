import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";
import { nodeFsPromises as fs, nodePath as path } from "../src/boundary/node-builtins.ts";
import {
  makeReportArchive,
  pruneReportArchive,
  reportArchiveRoot,
} from "../src/boundary/report-archive.ts";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { vi } from "vitest";
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
  it.effect("keeps a long report out of context behind a preview and its private file", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = makeReportArchive(agent, "session-1");
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const notify = makeHostNotifier(extensionApiFixture({ sendMessage }), {
        archive: () => archive,
      });
      const report = Array.from({ length: 2_000 }, (_, line) => `finding ${line}`).join("\n");

      notify({
        type: "completed",
        runs: [
          { id: "agent-1", name: "reader", generation: 2, outcome: "completed", finalText: report },
        ],
      });

      const text = sentText(sendMessage);
      expect(text.length).toBeLessThan(5_000);
      expect(text).toContain("finding 0");
      expect(text).not.toContain("finding 1999");
      const file = path.join(reportArchiveRoot(agent), "session-1", "agent-1-2.md");
      expect(text).toContain(file);
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(report);
      expect((yield* Effect.promise(() => fs.stat(file))).mode & 0o777).toBe(0o600);
    }).pipe(Effect.scoped),
  );

  it.live("removes reports older than a week", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const archive = makeReportArchive(agent, "session-1");
      const old = archive({ id: "agent-1", generation: 1, text: "old" });
      const fresh = archive({ id: "agent-2", generation: 1, text: "fresh" });
      if (!old || !fresh) return yield* Effect.die("archive write failed");
      const now = yield* Clock.currentTimeMillis;
      const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
      yield* Effect.promise(() => fs.utimes(old.path, eightDaysAgo, eightDaysAgo));

      yield* Effect.promise(() => pruneReportArchive(agent, now));

      expect(yield* exists(old.path)).toBe(false);
      expect(yield* exists(fresh.path)).toBe(true);
      return undefined;
    }).pipe(Effect.scoped),
  );
});
