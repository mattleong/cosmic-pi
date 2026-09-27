import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import type { BackgroundTaskStatus } from "../src/task/model.ts";
import { BackgroundTaskService } from "../src/task/service.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { executeBackgroundTaskCommand } from "../src/tools/command.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

const base = {
  command: "pnpm test",
  cwd: "/project",
  startedAt: 1,
  logCursor: 12,
  droppedLogBytes: 0,
};
const failed: BackgroundTaskStatus = {
  ...base,
  id: "bg-1",
  name: "tests",
  state: "failed",
  endedAt: 2,
  exitCode: 1,
  failureCause: "FAIL tests/auth.test.ts > rejects expired tokens",
};
const killed: BackgroundTaskStatus = {
  ...base,
  id: "bg-2",
  name: "build",
  command: "pnpm build",
  state: "failed",
  endedAt: 2,
  exitCode: 137,
};
const running: BackgroundTaskStatus = {
  ...base,
  id: "bg-3",
  name: "server",
  command: "pnpm dev",
  state: "running",
};
const byId = new Map([failed, killed, running].map((task) => [task.id, task]));
const unexpected = () => Effect.die("Gallery reached an unexpected service call");
const service = {
  start: unexpected,
  list: () => Effect.succeed([running, failed, killed]),
  status: (id: string) => Effect.succeed(byId.get(id)!),
  logs: unexpected,
  wait: unexpected,
  stop: unexpected,
  stopAll: unexpected,
  clear: unexpected(),
};

const scenarios: ReadonlyArray<readonly [string, BackgroundTaskToolInput]> = [
  ["failed task with a cause", { action: "status", id: "bg-1" }],
  ["task killed without output", { action: "status", id: "bg-2" }],
  ["list with failures", { action: "list" }],
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders background task outcomes in both collapsed styles", () =>
    Effect.gen(function* () {
      const results = [];
      for (const [title, input] of scenarios) {
        const result = yield* executeBackgroundTaskCommand(input, "/project").pipe(
          Effect.provideService(BackgroundTaskService, service),
          Effect.provide(Path.layer),
        );
        results.push({
          title,
          args: input,
          result: {
            content: [{ type: "text" as const, text: result.text }],
            details: result.details,
          },
        });
      }
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = captureRegistrations((pi) =>
            registerBackgroundTaskTool(pi, {
              run: () => Promise.reject(new Error("not executed")),
            }),
          ).tools[0]!;
          for (const scenario of results)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-background-task", lines);
    }),
  );
});
