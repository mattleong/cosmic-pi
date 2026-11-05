import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, vi } from "vitest";
import rexBtw from "../src/extension.ts";
import { REX_UNAVAILABLE_MESSAGE } from "../src/launch.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const harness = (sessionFile?: string) => {
  const notify = vi.fn();
  const host = recordingExtensionHost({}, { registerFlag() {}, getFlag: () => undefined });
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    ui: { notify },
    sessionManager: {
      getSessionId: () => "01a1a579-f3f7-7000-a118-5bf07d3e800a",
      getSessionFile: () => sessionFile,
    },
  });
  rexBtw(host.pi);
  return {
    notify,
    start: () => host.emit("session_start", ctx),
    shutdown: () => host.emit("session_shutdown", ctx),
    btw: (args: string) => host.commands.get("btw")!.handler(args, ctx),
  };
};

describe("/btw", () => {
  it.effect("explains that it needs a Rex pane when the session runs elsewhere", () =>
    Effect.gen(function* () {
      vi.stubEnv("REX_SESSION", undefined);
      vi.stubEnv("REX_BLOCK", undefined);
      const h = harness();
      yield* Effect.promise(h.start);
      yield* Effect.promise(() => Promise.resolve(h.btw("question")));
      expect(h.notify).toHaveBeenCalledExactlyOnceWith(REX_UNAVAILABLE_MESSAGE, "error");
      yield* Effect.promise(h.shutdown);
    }),
  );

  it.effect("rejects a prompt that can't be passed to a new pane before contacting Rex", () =>
    Effect.gen(function* () {
      vi.stubEnv("REX_SESSION", "session:s");
      vi.stubEnv("REX_BLOCK", "block:b");
      vi.stubEnv("REX_BIN_DIR", "/nonexistent-rex-bin");
      const h = harness();
      yield* Effect.promise(h.start);
      yield* Effect.promise(() => Promise.resolve(h.btw("a\0b")));
      expect(h.notify).toHaveBeenCalledOnce();
      expect(h.notify.mock.calls[0]?.[1]).toBe("error");
      yield* Effect.promise(h.shutdown);
    }),
  );

  it.effect("opens no pane that couldn't read this conversation, and says what to do", () =>
    Effect.gen(function* () {
      vi.stubEnv("REX_SESSION", "session:s");
      vi.stubEnv("REX_BLOCK", "block:b");
      // A pane that tried to open would fail here and report an error.
      vi.stubEnv("REX_BIN_DIR", "/nonexistent-rex-bin");
      for (const sessionFile of [undefined, "/nonexistent/session.jsonl"]) {
        const h = harness(sessionFile);
        yield* Effect.promise(h.start);
        yield* Effect.promise(() => Promise.resolve(h.btw("question")));
        expect(h.notify).toHaveBeenCalledOnce();
        expect(h.notify.mock.calls[0]?.[1]).toBe("warning");
        yield* Effect.promise(h.shutdown);
      }
    }),
  );
});
