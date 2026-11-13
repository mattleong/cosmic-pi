import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
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
    /** Starts the session and shuts it down when the test's scope closes, even after a failure. */
    started: Effect.acquireRelease(
      Effect.promise(() => host.emit("session_start", ctx)),
      () => Effect.promise(() => host.emit("session_shutdown", ctx)),
    ),
    btw: (args: string) => host.commands.get("btw")!.handler(args, ctx),
  };
};

/** Places the session in a Rex pane whose `rex` binary lives in `binDirectory`. */
const stubRexPane = (binDirectory: string): void => {
  vi.stubEnv("REX_SESSION", "session:s");
  vi.stubEnv("REX_BLOCK", "block:b");
  vi.stubEnv("REX_BIN_DIR", binDirectory);
};

/**
 * A stand-in `rex` that records each call's arguments and answers as Rex would, beside a saved
 * parent session file; removed when the test's scope closes.
 */
const fakeRex = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rex-btw-command-" });
  const log = path.join(root, "calls.log");
  const rex = path.join(root, "rex");
  yield* fs.writeFileString(
    rex,
    Arr.join(
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "$REX_TEST_LOG"',
        'case "$1" in',
        "  block) echo '{\"columns\":120}' ;;",
        '  split) echo \'{"block_ids":["block:btw"]}\' ;;',
        "esac",
        "",
      ],
      "\n",
    ),
  );
  yield* fs.chmod(rex, 0o755);
  const sessionFile = path.join(root, "parent.jsonl");
  yield* fs.writeFileString(sessionFile, "");
  stubRexPane(root);
  vi.stubEnv("REX_TEST_LOG", log);
  const calls = Effect.map(
    Effect.orElseSucceed(fs.readFileString(log), () => ""),
    (text) => Str.split(Str.trimEnd(text), "\n"),
  );
  return { sessionFile, calls };
});

describe("/btw", () => {
  it.effect("shows help without opening a pane, even before the conversation is saved", () =>
    Effect.gen(function* () {
      const rex = yield* fakeRex;
      const h = harness();
      yield* h.started;
      yield* Effect.promise(() => Promise.resolve(h.btw("help")));
      expect(h.notify).toHaveBeenCalledOnce();
      expect(h.notify.mock.calls[0]?.[1]).toBe("info");
      expect(yield* rex.calls).toEqual([""]);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("opens a pane that asks the question given after the command", () =>
    Effect.gen(function* () {
      const rex = yield* fakeRex;
      const h = harness(rex.sessionFile);
      yield* h.started;
      yield* Effect.promise(() => Promise.resolve(h.btw("why does the cart test fail?")));
      expect(h.notify).not.toHaveBeenCalled();
      const calls = yield* rex.calls;
      expect(calls).toContain("split");
      expect(calls).toContain("why does the cart test fail?");
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("explains that it needs a Rex pane when the session runs elsewhere", () =>
    Effect.gen(function* () {
      vi.stubEnv("REX_SESSION", undefined);
      vi.stubEnv("REX_BLOCK", undefined);
      const h = harness();
      yield* h.started;
      yield* Effect.promise(() => Promise.resolve(h.btw("question")));
      expect(h.notify).toHaveBeenCalledExactlyOnceWith(REX_UNAVAILABLE_MESSAGE, "error");
    }),
  );

  it.effect("rejects a prompt that can't be passed to a new pane before contacting Rex", () =>
    Effect.gen(function* () {
      stubRexPane("/nonexistent-rex-bin");
      const h = harness();
      yield* h.started;
      yield* Effect.promise(() => Promise.resolve(h.btw("a\0b")));
      expect(h.notify).toHaveBeenCalledOnce();
      expect(h.notify.mock.calls[0]?.[1]).toBe("error");
    }),
  );

  it.effect("opens no pane that couldn't read this conversation, and says what to do", () =>
    Effect.gen(function* () {
      // A pane that tried to open would fail here and report an error.
      stubRexPane("/nonexistent-rex-bin");
      for (const sessionFile of [undefined, "/nonexistent/session.jsonl"]) {
        const h = harness(sessionFile);
        yield* h.started;
        yield* Effect.promise(() => Promise.resolve(h.btw("question")));
        expect(h.notify).toHaveBeenCalledOnce();
        expect(h.notify.mock.calls[0]?.[1]).toBe("warning");
      }
    }),
  );
});
