// The deliberate `code_mode` deactivation intent survives Pi recreating the extension module
// on reload/new/resume/fork. These suites cover the pure handoff (identity resolution, TTL,
// consume-on-capture) and an integration flow that destroys the old application closure,
// constructs a fresh one, and replays realistic session events.
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { registerCodeModeApplication } from "../src/application.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";
import {
  codeModeSessionKey,
  makeCodeModeDeactivationHandoff,
} from "../src/boundary/host-deactivation-handoff.ts";
import { CODE_MODE_TOOL_NAME } from "../src/tools/controller.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdtempSync, rmSync } = nodeFsModule;
const { join } = nodePathModule;

// Mutating the agent-directory slot is this suite's process-environment host boundary.
const processEnv: NodeJS.ProcessEnv = process.env;

const HANDOFF_SLOT = Symbol.for("@cosmic-pi/pi-code-mode/code-mode-deactivation-handoff/v2");
const clearSlot = () => {
  Reflect.deleteProperty(globalThis, HANDOFF_SLOT);
};

beforeEach(clearSlot);
afterEach(clearSlot);

describe("codeModeSessionKey", () => {
  it("uses the stable Pi session id", () => {
    const ctx = extensionContextFixture({
      cwd: "/project",
      sessionManager: { getSessionId: () => "session-123" },
    });
    expect(codeModeSessionKey(ctx)).toBe("session-123");
  });

  it("never falls back to the cwd when no usable session id is exposed", () => {
    // A cwd key would let a genuinely different session in the same project inherit another
    // session's intent, so the only fallback is no identity at all.
    expect(codeModeSessionKey(extensionContextFixture({ cwd: "/project" }))).toBeUndefined();

    const throwing = extensionContextFixture({
      cwd: "/project",
      sessionManager: {
        getSessionId: () => {
          throw new Error("no session");
        },
      },
    });
    expect(codeModeSessionKey(throwing)).toBeUndefined();

    const empty = extensionContextFixture({
      cwd: "/project",
      sessionManager: { getSessionId: () => "" },
    });
    expect(codeModeSessionKey(empty)).toBeUndefined();
  });

  it("returns undefined when no identity is available", () => {
    expect(codeModeSessionKey(extensionContextFixture({}))).toBeUndefined();
  });
});

describe("makeCodeModeDeactivationHandoff", () => {
  const sessionKey = "S1";

  it("captures the exact intent published for a matching key, then clears it", () => {
    const handoff = makeCodeModeDeactivationHandoff();
    handoff.publish(sessionKey, true);
    expect(handoff.capture(sessionKey)).toBe(true);
    // Consumed on capture: a second capture finds nothing.
    expect(handoff.capture(sessionKey)).toBeUndefined();
  });

  it("shares one process slot across independently-created handoff instances", () => {
    // This is the property the reload restore relies on: the recreated module's handoff
    // reads what the old module's handoff wrote.
    makeCodeModeDeactivationHandoff().publish(sessionKey, true);
    expect(makeCodeModeDeactivationHandoff().capture(sessionKey)).toBe(true);
  });

  it("never returns another session's intent (no cross-session leakage)", () => {
    const handoff = makeCodeModeDeactivationHandoff();
    handoff.publish("S1", true);
    expect(handoff.capture("S2")).toBeUndefined();
  });

  it("expires a session entry after its bounded TTL", () => {
    const handoff = makeCodeModeDeactivationHandoff();
    handoff.publish(sessionKey, true);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60 * 60 * 1_000 + 1_000;
      expect(handoff.capture(sessionKey)).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it("publishes and captures nothing for an unidentifiable session", () => {
    const handoff = makeCodeModeDeactivationHandoff();
    handoff.publish(undefined, true);
    expect(handoff.capture(undefined)).toBeUndefined();
  });
});

type Handler = ExtensionHandler<any, any>;

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete processEnv.PI_CODING_AGENT_DIR;
});

/** One extension-module instance over a mutable active-tool list; recreatable to model reload. */
const instance = (activeTools: string[], sessionId: string | undefined, sharedCwd?: string) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-handoff-agent-"));
  tempDirectories.push(agentDir);
  processEnv.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const registerTool = vi.fn();
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => undefined,
    registerTool,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.length = 0;
      activeTools.push(...names);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  });

  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  registerCodeModeApplication(pi, {
    loadSettings: () => Promise.resolve(undefined),
    wrapTool: (tool) => tool,
    makeNestedDefinitions: () => ({}) as NestedPiToolDefinitions,
  });

  let cwd = sharedCwd;
  if (cwd === undefined) {
    cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-handoff-cwd-"));
    tempDirectories.push(cwd);
  }
  const baseCtx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    ui: { notify: vi.fn(), custom: vi.fn(), select: vi.fn() },
    isProjectTrusted: () => true,
  };
  const ctx = extensionContextFixture(
    sessionId === undefined
      ? baseCtx
      : { ...baseCtx, sessionManager: { getSessionId: () => sessionId } },
  );

  return { handlers, registerTool, ctx };
};

describe("deactivation intent across module recreation", () => {
  it.effect("preserves a deliberate deactivation across a reload that recreates the module", () =>
    Effect.gen(function* () {
      const active = ["read", "bash"];

      // Old module: session starts, code_mode registers and activates.
      const a = instance(active, "session-A");
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);

      // The user deliberately deactivates code_mode mid-session.
      active.splice(active.indexOf(CODE_MODE_TOOL_NAME), 1);
      expect(active).not.toContain(CODE_MODE_TOOL_NAME);

      // Reload: the old module shuts down (publishing intent), then a fresh module is created.
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      const b = instance(active, "session-A");
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "reload" }, b.ctx)),
      );

      // The fresh module re-registers the tool but honors the preserved deactivation.
      expect(b.registerTool).toHaveBeenCalledTimes(1);
      expect(active).not.toContain(CODE_MODE_TOOL_NAME);
    }),
  );

  it.effect("does not leak deactivation into a genuinely different session (new/fork)", () =>
    Effect.gen(function* () {
      const active = ["read", "bash"];

      const a = instance(active, "session-A");
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      active.splice(active.indexOf(CODE_MODE_TOOL_NAME), 1);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      // A new session (different id) recreates the module: it must start activated again.
      const b = instance(active, "session-B");
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "new" }, b.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);
    }),
  );

  it.effect("preserves an active tool across reload (no false deactivation)", () =>
    Effect.gen(function* () {
      const active = ["read", "bash"];

      const a = instance(active, "session-A");
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      // The user leaves code_mode active.
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      const b = instance(active, "session-A");
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "reload" }, b.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);
    }),
  );

  it.effect("restores across resume when the session identity matches", () =>
    Effect.gen(function* () {
      const active = ["read", "bash"];

      const a = instance(active, "session-resume");
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      active.splice(active.indexOf(CODE_MODE_TOOL_NAME), 1);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      const b = instance(active, "session-resume");
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "resume" }, b.ctx)),
      );
      expect(active).not.toContain(CODE_MODE_TOOL_NAME);
    }),
  );

  it.effect("does not leak deactivation into a different session in the same cwd", () =>
    Effect.gen(function* () {
      // Same project directory, different session id: without the removed cwd fallback the
      // fresh module must start activated.
      const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-handoff-shared-cwd-"));
      tempDirectories.push(cwd);
      const active = ["read", "bash"];

      const a = instance(active, "session-A", cwd);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      active.splice(active.indexOf(CODE_MODE_TOOL_NAME), 1);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      const b = instance(active, "session-B", cwd);
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "new" }, b.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);
    }),
  );

  it.effect("preserves nothing when no session id is exposed, even in the same cwd", () =>
    Effect.gen(function* () {
      // With no stable identity nothing is published; the safe default (activated) wins and a
      // later session in the same project can never inherit the intent.
      const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-handoff-no-id-cwd-"));
      tempDirectories.push(cwd);
      const active = ["read", "bash"];

      const a = instance(active, undefined, cwd);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_start")?.({ reason: "startup" }, a.ctx)),
      );
      active.splice(active.indexOf(CODE_MODE_TOOL_NAME), 1);
      yield* Effect.promise(() =>
        Promise.resolve(a.handlers.get("session_shutdown")?.({ reason: "reload" }, a.ctx)),
      );

      const b = instance(active, undefined, cwd);
      yield* Effect.promise(() =>
        Promise.resolve(b.handlers.get("session_start")?.({ reason: "reload" }, b.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);

      const c = instance(active, "session-C", cwd);
      yield* Effect.promise(() =>
        Promise.resolve(c.handlers.get("session_start")?.({ reason: "new" }, c.ctx)),
      );
      expect(active).toContain(CODE_MODE_TOOL_NAME);
    }),
  );
});
