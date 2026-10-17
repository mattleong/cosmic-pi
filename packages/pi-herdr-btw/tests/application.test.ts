import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwApplication } from "../src/application.ts";

const harness = () => {
  const notify = vi.fn();
  const host = recordingExtensionHost(
    {},
    { registerFlag() {}, getFlag: () => undefined, appendEntry() {} },
  );
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    sessionManager: {
      getSessionFile: () => "/sessions/parent.jsonl",
      getSessionId: () => "parent-session",
      getSessionDir: () => "/sessions",
      getEntries: () => [],
      getHeader: () => null,
    },
    ui: { notify },
  });
  registerHerdrBtwApplication(host.pi);
  return {
    ctx,
    notify,
    open: () => host.commands.get("herdr-btw")!.handler("", ctx),
    start: () => host.emit("session_start", ctx),
    shutdown: () => host.emit("session_shutdown", ctx),
  };
};

describe("herdr-btw session host capture", () => {
  it.effect("does not report command settlement after the owning session shuts down", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.promise(() => h.start());
      const pending = h.open();
      yield* Effect.promise(() => h.shutdown());
      yield* Effect.promise(() => Promise.resolve(pending));
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );
});
