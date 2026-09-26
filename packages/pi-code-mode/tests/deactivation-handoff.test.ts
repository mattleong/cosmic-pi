import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach } from "vitest";
import {
  captureCodeModeDeactivation,
  codeModeSessionKey,
  publishCodeModeDeactivation,
} from "../src/boundary/host-deactivation-handoff.ts";
import { CODE_MODE_TOOL_NAME } from "../src/tools/controller.ts";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { applicationHarness, cleanupApplications } from "./support/application.ts";

const HANDOFF_SLOT = Symbol.for("@cosmic-pi/pi-code-mode/code-mode-deactivation-handoff/v2");
const clearSlot = () => Reflect.deleteProperty(globalThis, HANDOFF_SLOT);

beforeEach(clearSlot);
afterEach(() => {
  clearSlot();
  cleanupApplications();
});

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

const deactivate = (activeTools: string[]): void => {
  const index = activeTools.indexOf(CODE_MODE_TOOL_NAME);
  if (index >= 0) activeTools.splice(index, 1);
};

describe("deactivation intent across sessions", () => {
  it.effect("finishes teardown when the process handoff slot rejects its first write", () =>
    Effect.gen(function* () {
      const active = ["read", "bash"];
      const application = applicationHarness({}, active);
      const ctx = application.makeContext({ sessionId: "session-A" });
      yield* Effect.promise(() => application.start(ctx));
      deactivate(active);

      Object.defineProperty(globalThis, HANDOFF_SLOT, {
        configurable: true,
        get: () => undefined,
        set: () => {
          throw new Error("poisoned handoff slot");
        },
      });
      // Simulate the host restoring the registered tool immediately after intent observation.
      // Shutdown must still remove it after the optional handoff publication attempt.
      application.restoreAfterNextRead();
      yield* Effect.promise(() => application.shutdown(ctx, "reload"));

      expect(active).toEqual(["read", "bash"]);
      expect(captureCodeModeDeactivation("session-A")).toBe(true);
    }),
  );

  it.effect.each([false, true])(
    "applies closure intent only to the same stable session (recreated=%s)",
    (recreate) =>
      Effect.gen(function* () {
        const transitions = [
          { next: "session-A", active: false },
          { next: "session-B", active: true },
          { next: undefined, active: true },
        ] as const;
        for (const transition of transitions) {
          clearSlot();
          const active = ["read", "bash"];
          let application = applicationHarness({}, active);
          yield* Effect.promise(() =>
            application.start(application.makeContext({ sessionId: "session-A" })),
          );
          deactivate(active);
          if (recreate) {
            // Shutdown context cannot replace the key captured at start.
            const shutdownCtx = application.makeContext({ sessionId: "session-B" });
            yield* Effect.promise(() => application.shutdown(shutdownCtx, "reload"));
            application = applicationHarness({}, active);
          }
          const next = application.makeContext({ sessionId: transition.next });
          const reason = transition.next === "session-A" ? "reload" : "new";
          yield* Effect.promise(() => application.start(next, reason));
          expect(active.includes(CODE_MODE_TOOL_NAME), String(transition.next)).toBe(
            transition.active,
          );
          yield* Effect.promise(() => application.shutdown(next, "reload"));
        }
      }),
  );
});
