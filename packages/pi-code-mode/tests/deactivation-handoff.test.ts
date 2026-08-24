import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { registerCodeModeApplication } from "../src/application.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";
import {
  captureCodeModeDeactivation,
  codeModeSessionKey,
  publishCodeModeDeactivation,
} from "../src/boundary/host-deactivation-handoff.ts";
import { CODE_MODE_TOOL_NAME } from "../src/tools/controller.ts";
import { extensionApiFixture, extensionContextFixture, opaqueHostFixture } from "./support/host.ts";

const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdtempSync, rmSync } = nodeFsModule;
const { join } = nodePathModule;
const processEnv: NodeJS.ProcessEnv = process.env;

const HANDOFF_SLOT = Symbol.for("@cosmic-pi/pi-code-mode/code-mode-deactivation-handoff/v2");
const clearSlot = () => Reflect.deleteProperty(globalThis, HANDOFF_SLOT);
const tempDirectories: string[] = [];

beforeEach(clearSlot);
afterEach(() => {
  clearSlot();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete processEnv.PI_CODING_AGENT_DIR;
});

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

describe("code mode deactivation handoff", () => {
  it("extracts only a non-empty stable Pi session id", () => {
    expect(
      codeModeSessionKey(
        extensionContextFixture({ sessionManager: { getSessionId: () => "session-123" } }),
      ),
    ).toBe("session-123");
    expect(codeModeSessionKey(extensionContextFixture({ cwd: "/same-project" }))).toBeUndefined();
    expect(
      codeModeSessionKey(extensionContextFixture({ sessionManager: { getSessionId: () => "" } })),
    ).toBeUndefined();
    expect(
      codeModeSessionKey(
        extensionContextFixture({
          sessionManager: {
            getSessionId: () => {
              throw new Error("no session");
            },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("consumes only a matching true handoff and clears old false envelopes", () => {
    publishCodeModeDeactivation("S1");
    expect(captureCodeModeDeactivation("S2")).toBeUndefined();
    expect(captureCodeModeDeactivation("S1")).toBe(true);
    expect(captureCodeModeDeactivation("S1")).toBeUndefined();

    Reflect.set(globalThis, HANDOFF_SLOT, {
      version: 2,
      key: "S1",
      deactivated: false,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(captureCodeModeDeactivation("S1")).toBeUndefined();
    expect(Reflect.has(globalThis, HANDOFF_SLOT)).toBe(false);
  });

  it("clears expired, non-finite, and throwing envelopes", () => {
    for (const expiresAt of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      Reflect.set(globalThis, HANDOFF_SLOT, {
        version: 2,
        key: "S1",
        deactivated: true,
        expiresAt,
      });
      expect(captureCodeModeDeactivation("S1")).toBeUndefined();
      expect(Reflect.has(globalThis, HANDOFF_SLOT)).toBe(false);
    }
    Reflect.set(
      globalThis,
      HANDOFF_SLOT,
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("hostile envelope");
          },
        },
      ),
    );
    expect(() => captureCodeModeDeactivation("S1")).not.toThrow();
    expect(Reflect.has(globalThis, HANDOFF_SLOT)).toBe(false);
  });
});

type Handler = ExtensionHandler<any, any>;

/** One extension instance over a caller-owned active-tool list. */
const applicationInstance = (activeTools: string[]) => {
  processEnv.PI_CODING_AGENT_DIR = temporaryDirectory("pi-code-mode-handoff-agent-");
  const cwd = temporaryDirectory("pi-code-mode-handoff-cwd-");
  const handlers = new Map<string, Handler>();
  const registerTool = vi.fn();
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => undefined,
    registerTool,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  });
  registerCodeModeApplication(pi, {
    loadSettings: () => Promise.resolve(opaqueHostFixture({})),
    wrapTool: (tool) => tool,
    makeNestedDefinitions: () => {
      // SAFETY: Execution is never invoked in these lifecycle-only tests.
      return {} as NestedPiToolDefinitions;
    },
  });
  const context = (sessionId: string | undefined) => {
    const mode = "rpc" as const;
    const base = {
      cwd,
      mode,
      hasUI: true,
      ui: { notify: vi.fn(), custom: vi.fn(), select: vi.fn() },
      isProjectTrusted: () => true,
    };
    return sessionId === undefined
      ? extensionContextFixture(base)
      : extensionContextFixture({
          ...base,
          sessionManager: { getSessionId: () => sessionId },
        });
  };
  return { handlers, registerTool, context };
};

const start = (
  application: ReturnType<typeof applicationInstance>,
  ctx: ReturnType<ReturnType<typeof applicationInstance>["context"]>,
  reason = "startup",
) =>
  Effect.promise(() =>
    Promise.resolve(application.handlers.get("session_start")?.({ reason }, ctx)),
  );

const shutdown = (
  application: ReturnType<typeof applicationInstance>,
  ctx: ReturnType<ReturnType<typeof applicationInstance>["context"]>,
) =>
  Effect.promise(() =>
    Promise.resolve(application.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx)),
  );

const deactivate = (activeTools: string[]): void => {
  const index = activeTools.indexOf(CODE_MODE_TOOL_NAME);
  if (index >= 0) activeTools.splice(index, 1);
};

describe("deactivation intent across sessions", () => {
  it.effect("applies closure intent only to the same stable session", () =>
    Effect.gen(function* () {
      const transitions = [
        { next: "session-A", active: false },
        { next: "session-B", active: true },
        { next: undefined, active: true },
      ] as const;
      for (const transition of transitions) {
        clearSlot();
        const active = ["read", "bash"];
        const application = applicationInstance(active);
        yield* start(application, application.context("session-A"));
        deactivate(active);
        const next = application.context(transition.next);
        yield* start(application, next, transition.next === "session-A" ? "reload" : "new");
        expect(active.includes(CODE_MODE_TOOL_NAME), String(transition.next)).toBe(
          transition.active,
        );
        yield* shutdown(application, next);
      }
    }),
  );

  it.effect("restores a recreated instance only for a matching handoff", () =>
    Effect.gen(function* () {
      const transitions = [
        { next: "session-A", active: false },
        { next: "session-B", active: true },
        { next: undefined, active: true },
      ] as const;
      for (const transition of transitions) {
        clearSlot();
        const active = ["read", "bash"];
        const oldInstance = applicationInstance(active);
        yield* start(oldInstance, oldInstance.context("session-A"));
        deactivate(active);
        // Shutdown context cannot replace the key captured at start.
        yield* shutdown(oldInstance, oldInstance.context("session-B"));

        const recreated = applicationInstance(active);
        const next = recreated.context(transition.next);
        yield* start(recreated, next, transition.next === "session-A" ? "reload" : "new");
        expect(active.includes(CODE_MODE_TOOL_NAME), String(transition.next)).toBe(
          transition.active,
        );
        yield* shutdown(recreated, next);
      }
    }),
  );
});
