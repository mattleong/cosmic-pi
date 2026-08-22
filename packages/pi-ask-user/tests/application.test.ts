// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askUserWithDependencies } from "../src/application.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

type Handler = ExtensionHandler<any, any>;
interface CapturedToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: AskUserOutcome;
}
interface CapturedTool {
  readonly execute: (
    id: string,
    input: AskUserRequest,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<CapturedToolResult>;
}
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const harness = (
  loadPreviewSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => Promise<void>,
  startupEffect: Effect.Effect<void> = Effect.void,
) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-ask-user-application-"));
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-ask-user-agent-"));
  directories.push(cwd, agentDirectory);
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  const handlers = new Map<string, Handler>();
  let tool: CapturedTool | undefined;
  const fixture = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand: vi.fn(),
    registerTool: vi.fn((definition: CapturedTool) => {
      tool = definition;
    }),
  };
  // SAFETY: The application uses only the ExtensionAPI methods supplied by this lifecycle fixture.
  const pi = fixture as typeof fixture & ExtensionAPI;
  askUserWithDependencies(pi, { loadPreviewSettings, startupEffect });
  const contextFixture = {
    cwd,
    hasUI: true,
    mode: "rpc",
    ui: { notify: vi.fn() },
    isProjectTrusted: () => true,
  };
  // SAFETY: The startup path reads only the context fields supplied by this fixture.
  const ctx = contextFixture as typeof contextFixture & ExtensionContext;
  const emit = (name: string) => Promise.resolve(handlers.get(name)?.({}, ctx));
  return {
    ctx,
    emit,
    fixture,
    get tool() {
      return tool;
    },
  };
};

describe("ask-user session admission", () => {
  it("loads preview settings before initializing the session runtime", async () => {
    let loaded = false;
    let initialized = 0;
    const h = harness(
      () =>
        Promise.resolve().then(() => {
          loaded = true;
        }),
      Effect.sync(() => {
        expect(loaded).toBe(true);
        initialized += 1;
      }),
    );

    await h.emit("session_start");
    expect(initialized).toBe(1);
    await h.emit("session_shutdown");
  });

  it("does not let an interrupted settings load initialize a replacement session", async () => {
    const first = deferred();
    let loads = 0;
    let initialized = 0;
    const signals: AbortSignal[] = [];
    const h = harness(
      (_cwd, _projectTrusted, signal) => {
        loads += 1;
        if (signal) signals.push(signal);
        return loads === 1 ? first.promise : Promise.resolve();
      },
      Effect.sync(() => {
        initialized += 1;
      }),
    );

    const staleStart = h.emit("session_start");
    while (loads < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const currentStart = h.emit("session_start");
    await Promise.all([staleStart, currentStart]);

    expect(loads).toBe(2);
    expect(initialized).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    first.resolve();
    await h.emit("session_shutdown");
  });

  it("rejects a stale tool call while replacement startup is pending", async () => {
    const replacement = deferred();
    let loads = 0;
    const h = harness(() => {
      loads += 1;
      return loads === 1 ? Promise.resolve() : replacement.promise;
    });
    await h.emit("session_start");

    const tool = h.tool;
    if (!tool) throw new Error("ask_user was not activated for the first session.");

    const replacing = h.emit("session_start");
    while (loads < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      tool.execute(
        "call",
        {
          questions: [
            {
              key: "choice",
              title: "Choice",
              prompt: "Choose.",
              mode: "single",
              choices: [
                { value: "a", label: "A", description: "Choose A." },
                { value: "b", label: "B", description: "Choose B." },
              ],
            },
          ],
        },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toMatchObject({ _tag: "AskUserRuntimeClosedError" });

    replacement.resolve();
    await replacing;
    await h.emit("session_shutdown");
  });
});
