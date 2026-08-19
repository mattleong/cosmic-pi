// @effect-diagnostics effect/asyncFunction:off
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { registerHerdrForkApplication } from "../src/application.ts";

type Handler = ExtensionHandler<any, any>;

type HarnessContext = ExtensionContext & {
  cwd: string;
  signal?: AbortSignal;
};

const harness = () => {
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  const piFixture = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand() {},
  };
  // SAFETY: The application uses only the ExtensionAPI members implemented by this fixture.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const contextFixture = {
    cwd: "/project",
    // SAFETY: The fixture intentionally exposes the optional host signal slot mutated by tests.
    signal: undefined as AbortSignal | undefined,
    mode: "tui" as const,
    hasUI: true,
    sessionManager: {
      getSessionFile: () => "/sessions/parent.jsonl",
      getSessionId: () => "parent-session",
    },
    ui: { notify },
  };
  // SAFETY: The application uses only the ExtensionContext members implemented by this fixture.
  const ctx = contextFixture as typeof contextFixture & HarnessContext;
  registerHerdrForkApplication(pi);
  const start = () => handlers.get("session_start")?.({ type: "session_start" }, ctx);
  const shutdown = () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  return { ctx, notify, start, shutdown };
};

const invoke = async <ValueInput>(value: ValueInput): Promise<void> => {
  await value;
};

describe("herdr-fork session host capture", () => {
  test("materializes cwd and signal once and never rereads the raw host signal", async () => {
    const h = harness();
    const controller = new AbortController();
    let cwdReads = 0;
    let signalReads = 0;
    Object.defineProperties(h.ctx, {
      cwd: {
        configurable: true,
        get() {
          cwdReads++;
          if (cwdReads > 1) throw new Error("host-cwd-reread-secret");
          return "/project";
        },
      },
      signal: {
        configurable: true,
        get() {
          signalReads++;
          if (signalReads > 1) throw new Error("host-signal-reread-secret");
          return controller.signal;
        },
      },
    });

    await invoke(h.start());

    expect(cwdReads).toBe(1);
    expect(signalReads).toBe(1);
    expect(h.notify).not.toHaveBeenCalled();
    await invoke(h.shutdown());
  });

  test("fails closed for a hostile signal getter", async () => {
    const h = harness();
    Object.defineProperty(h.ctx, "signal", {
      configurable: true,
      get() {
        throw new Error("host-signal-secret");
      },
    });

    let startup: unknown;
    expect(() => {
      startup = h.start();
    }).not.toThrow();
    await invoke(startup);

    expect(h.notify).toHaveBeenCalledWith(
      "The /herdr-fork command could not capture this Pi session.",
      "error",
    );
  });

  test("fails closed when the captured session is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    h.ctx.signal = controller.signal;

    await invoke(h.start());

    expect(h.notify).toHaveBeenCalledWith(
      "The /herdr-fork command could not capture this Pi session.",
      "error",
    );
  });

  test("fails closed when reading captured aborted state throws", async () => {
    const h = harness();
    const hostileSignal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error("host-aborted-secret");
      },
    });
    Object.defineProperty(h.ctx, "signal", {
      configurable: true,
      value: hostileSignal,
    });

    await invoke(h.start());

    expect(h.notify).toHaveBeenCalledWith(
      "The /herdr-fork command could not capture this Pi session.",
      "error",
    );
  });
});
