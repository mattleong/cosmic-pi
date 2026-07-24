import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundJobSnapshot } from "../src/job/model.ts";
import {
  BackgroundTerminalService,
  type BackgroundTerminalServiceShape,
} from "../src/job/service.ts";
import {
  registerBackgroundTerminalTool,
  type BackgroundTerminalToolInput,
} from "../src/tools/background-terminal.ts";

interface CapturedTool {
  readonly execute: (
    id: string,
    input: BackgroundTerminalToolInput,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  }>;
}

const snapshot: BackgroundJobSnapshot = {
  id: "term-1",
  command: "npm run dev",
  cwd: "/project",
  state: "running",
  pid: 123,
  startedAt: 1,
  logCursor: 1,
  droppedLogBytes: 0,
};

describe("background_terminal tool", () => {
  it("dispatches every action through one agent-facing tool", () => {
    const calls: string[] = [];
    const service: BackgroundTerminalServiceShape = {
      start: (request) => Effect.sync(() => (calls.push(`start:${request.cwd}`), snapshot)),
      list: () => Effect.sync(() => (calls.push("list"), [snapshot])),
      status: () => Effect.sync(() => (calls.push("status"), snapshot)),
      logs: () =>
        Effect.sync(() => {
          calls.push("logs");
          return {
            id: snapshot.id,
            events: [
              {
                cursor: 1,
                stream: "stdout" as const,
                text: "\u001b[31mready\u001b[0m\n",
                timestamp: 1,
                bytes: 6,
              },
            ],
            nextCursor: 1,
            earliestAvailableCursor: 1,
            droppedBytes: 0,
            state: snapshot.state,
          };
        }),
      stop: () => Effect.sync(() => (calls.push("stop"), { ...snapshot, state: "stopped" })),
      stopAll: () => Effect.sync(() => (calls.push("stop_all"), [snapshot])),
      clear: Effect.sync(() => (calls.push("clear"), 1)),
      projection: Effect.succeed({ revision: 0, jobs: [] }),
    };
    const runtime = ManagedRuntime.make(
      Layer.merge(Path.layer, Layer.succeed(BackgroundTerminalService, service)),
    );
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: vi.fn((definition: unknown) => {
        tool = definition as CapturedTool;
      }),
    } as unknown as ExtensionAPI;
    registerBackgroundTerminalTool(pi, {
      run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
    });
    const context = { cwd: "/project" } as ExtensionContext;
    const execute = (input: BackgroundTerminalToolInput) =>
      tool?.execute("call", input, undefined, undefined, context) ??
      Promise.reject(new Error("tool not registered"));

    return Promise.all([
      execute({ action: "start", command: "npm run dev" }),
      execute({ action: "list" }),
      execute({ action: "status", id: "term-1" }),
      execute({ action: "logs", id: "term-1" }),
      execute({ action: "stop", id: "term-1" }),
      execute({ action: "stop_all" }),
      execute({ action: "clear" }),
    ])
      .then((results) => {
        expect(calls.sort()).toEqual(
          ["clear", "list", "logs", "start:/project", "status", "stop", "stop_all"].sort(),
        );
        const logText = results[3]?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        expect(logText).toContain("ready");
        expect(logText).not.toContain("\u001b");
        expect(logText).toContain("cursor=1");
      })
      .finally(() => runtime.dispose());
  });
});
