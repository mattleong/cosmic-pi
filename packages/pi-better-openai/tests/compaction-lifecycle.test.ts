import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import { OPENAI_COMPACTION_DETAILS_TYPE } from "../src/compaction/protocol.ts";
import { extensionHarness } from "./extension-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const checkpointedSession = (cwd: string) => {
  const manager = SessionManager.inMemory(cwd);
  const retained = manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
  manager.appendCompaction(
    "owned",
    retained,
    100,
    {
      type: OPENAI_COMPACTION_DETAILS_TYPE,
      checkpoint: {
        version: 1,
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.5",
        output: [{ type: "compaction", encrypted_content: "encrypted" }],
        omittedEntryIds: [],
        createdAt: 0,
      },
    },
    true,
  );
  return manager;
};

layer(nodeFilePlatformLayer)("compaction session authority", (it) => {
  it.effect("retirement discards pending provider payload changes", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      h.getFlag.mockReturnValue(true);
      yield* h.emit("session_start");
      const pending = h.handlers.get("before_provider_request")[0]!(
        { type: "before_provider_request", payload: {} },
        h.ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        h.ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toBeUndefined();
    }),
  );

  it.effect("retired context repair cannot abort or notify the host", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      const manager = checkpointedSession(h.cwd);
      const ctx = { ...h.ctx, sessionManager: manager, abort: vi.fn() };
      yield* h.emit("session_start", ctx);
      h.notify.mockClear();
      const pending = h.handlers.get("context_with_system")[0]!(
        { type: "context_with_system", messages: manager.buildSessionContext().messages },
        ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toBeUndefined();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("retired compaction cancels without offering native fallback or notifying", () =>
    Effect.gen(function* () {
      const h = yield* extensionHarness();
      yield* h.emit("session_start");
      h.notify.mockClear();
      const pending = h.handlers.get("session_before_compact")[0]!(
        {
          type: "session_before_compact",
          preparation: {
            firstKeptEntryId: "retained",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 100,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
          },
          branchEntries: [],
          reason: "manual",
          willRetry: false,
          signal: yield* Effect.abortSignal,
        },
        h.ctx,
      );
      const shutdown = h.handlers.get("session_shutdown")[0]!(
        { type: "session_shutdown", reason: "quit" },
        h.ctx,
      );

      const result = yield* Effect.promise(() => Promise.resolve(pending));
      yield* Effect.promise(() => Promise.resolve(shutdown));

      expect(result).toEqual({ cancel: true });
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );
});
