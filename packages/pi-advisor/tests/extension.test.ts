// Test harness boundary: Pi callbacks and fake child sessions are Promise-shaped fixtures.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { test, vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeStartOptions,
} from "../src/runtime/runtime.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";
import { type ResolvedAdvisorConfig } from "../src/config/options.ts";
import { createAdvisorExtension } from "../src/extension.ts";
import { deferred, tick } from "./support/async.ts";
import { finalTurn, passCheckpoint as pass } from "./support/checkpoints.ts";
import { memoryAdvisorConfigStore, resolvedAdvisorConfig } from "./support/config.ts";
import { configStoreLayerFromLoad, failureLoggerLayerFromLog } from "./support/layers.ts";
import {
  advisorExtensionApi,
  advisorExtensionContext,
  anchorUserBranch,
  commandRegistry,
  handlerRegistry,
  type AdvisorHostEntry,
} from "./support/extension-host.ts";
import { controllableRuntimeService } from "./support/runtime-service.ts";

type TrackedAbortListener = EventListenerOrEventListenerObject;

function trackedAbortSignal() {
  let aborted = false;
  const added: TrackedAbortListener[] = [];
  const removed: TrackedAbortListener[] = [];
  const live = new Set<TrackedAbortListener>();
  const addEventListener = vi.fn((_type: string, listener: TrackedAbortListener) => {
    added.push(listener);
    live.add(listener);
  });
  const removeEventListener = vi.fn((_type: string, listener: TrackedAbortListener) => {
    removed.push(listener);
    live.delete(listener);
  });
  const signalFixture = {
    get aborted() {
      return aborted;
    },
    addEventListener,
    removeEventListener,
  };
  // SAFETY: These tests exercise only aborted and listener registration on this signal fixture.
  const signal = signalFixture as typeof signalFixture & AbortSignal;
  return {
    signal,
    abort: () => {
      if (aborted) return;
      aborted = true;
      for (const listener of live) {
        const event = new Event("abort");
        if (Predicate.isFunction(listener)) {
          // SAFETY: Predicate.isFunction proved this listener has the EventListener callable branch.
          const callback = listener as EventListener;
          callback.call(signal, event);
        } else listener.handleEvent(event);
      }
    },
    addedListeners: () => [...added],
    liveListeners: () => [...live],
    removalCount: (listener: TrackedAbortListener) =>
      removed.filter((candidate) => candidate === listener).length,
  };
}

function expectAbortListenersReleasedExactlyOnce(tracker: ReturnType<typeof trackedAbortSignal>) {
  const added = tracker.addedListeners();
  expect(added.length).toBeGreaterThan(0);
  expect(new Set(added).size).toBe(added.length);
  expect(tracker.liveListeners()).toHaveLength(0);
  for (const listener of added) expect(tracker.removalCount(listener)).toBe(1);
}

function harness(
  overrides: Partial<ResolvedAdvisorConfig> = {},
  options: {
    runtimeStartError?: Error;
    runtimeStartPromises?: Array<Promise<void> | undefined>;
    runtimeDisposePromises?: Array<Promise<void> | undefined>;
    branch?: AdvisorHostEntry[];
    memoryConfig?: boolean;
    configPatchError?: boolean;
    withoutSessionId?: boolean;
  } = {},
) {
  const registry = handlerRegistry();
  const { commands, registerCommand } = commandRegistry();
  const sendMessage = vi.fn();
  const appended: unknown[] = [];
  const runtimeService = controllableRuntimeService({
    startError: options.runtimeStartError,
    startPromises: options.runtimeStartPromises,
    disposePromises: options.runtimeDisposePromises,
  });
  const runtimes = runtimeService.runtimes;
  const branch = options.branch ?? anchorUserBranch();
  const pi = advisorExtensionApi({
    on: registry.on,
    registerCommand,
    sendMessage,
    appendEntry: (customType: string, data) => {
      appended.push(data);
      branch.push({
        id: `ledger-${branch.length}`,
        type: "custom",
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "now",
        customType,
        data,
      });
    },
  });
  const ctx = advisorExtensionContext({
    getBranch: () => branch,
    withoutSessionId: options.withoutSessionId,
  });
  const logFailure = vi.fn();
  const initialConfig = resolvedAdvisorConfig(overrides);
  const memoryConfigStore = memoryAdvisorConfigStore(
    initialConfig,
    options.configPatchError ? "Advisor configuration update failed." : undefined,
  );
  createAdvisorExtension({
    configStore:
      options.memoryConfig || options.configPatchError
        ? memoryConfigStore
        : configStoreLayerFromLoad(() => initialConfig),
    runtimeService: runtimeService.layer,
    failureLogger: failureLoggerLayerFromLog(logFailure),
  })(pi);
  const emitWithContext = registry.emitWithContext;
  const emitAwait = <Event>(name: string, event: Event) => emitWithContext(name, event, ctx);
  const emit = <Event>(name: string, event: Event): Promise<void> => {
    if (name !== "turn_end") return emitAwait(name, event);
    registry.emitDetachedWithContext(name, event, ctx);
    return Promise.resolve();
  };
  return {
    appended,
    branch,
    commands,
    ctx,
    emit,
    emitAwait,
    emitWithContext,
    logFailure,
    runtimes,
    sendMessage,
  };
}

function revise(
  request: AdvisorCheckpointRequest,
  severity: "blocker" | "concern" = "blocker",
  issue = "The answer is wrong.",
): AdvisorCheckpoint {
  return {
    ...pass(request),
    verdict: "revise",
    summary: "An issue remains.",
    findings: [
      {
        fingerprint:
          issue
            .normalize("NFKC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 160) || "finding",
        category: "correctness",
        severity,
        confidence: "high",
        evidenceBasis: "direct",
        issue,
        evidence: "The transcript contradicts it.",
        recommendation: "Correct the answer.",
      },
    ],
  };
}

function confidentBlocker(
  request: AdvisorCheckpointRequest,
  fingerprint = "verified-blocker",
): AdvisorCheckpoint {
  const checkpoint = revise(request, "blocker", "A verified blocker remains.");
  return {
    ...checkpoint,
    findings: checkpoint.findings.map((finding) => ({
      ...finding,
      fingerprint,
      confidence: "high",
      evidenceBasis: "direct",
    })),
  };
}

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

/** Serialized snapshot for content-leak assertions at this Promise-shaped test boundary. */
const serializedSnapshot = <ValueInput>(value: ValueInput): string => JSON.stringify(value);

const runtimeDiagnostic = (
  runtime: ReturnType<typeof harness>["runtimes"][number],
): NonNullable<AdvisorRuntimeStartOptions["onDiagnostic"]> => {
  // SAFETY: controllableRuntimeService records the typed AdvisorRuntimeStartOptions passed to start.
  const options = runtime.driver.start.mock.calls[0]?.[0] as AdvisorRuntimeStartOptions | undefined;
  if (!options?.onDiagnostic) throw new Error("missing runtime diagnostic callback");
  return options.onDiagnostic;
};

const usageSnapshot = (value: ReturnType<typeof harness>): Effect.Effect<string> =>
  Effect.gen(function* () {
    // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
    yield* invoke(value.commands.get("advisor")!.handler("usage", value.ctx as never));
    const calls = vi.mocked(value.ctx.ui.notify).mock.calls;
    return String(calls.at(-1)?.[0] ?? "");
  });

const resolveVerifiedBlocker = (
  runtime: ReturnType<typeof harness>["runtimes"][number],
  initialIndex: number,
  issue = "The answer is wrong.",
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const initial = revise(runtime.requests[initialIndex]!, "blocker", issue);
    runtime.pending[initialIndex]!.resolve(initial);
    yield* Effect.promise(() => tick());
    const verificationIndex = runtime.requests.length - 1;
    expect(runtime.requests[verificationIndex]?.focus).toBe("blocker-verification");
    expect(runtime.requests[verificationIndex]?.verificationReview?.findings).toEqual(
      initial.findings,
    );
    runtime.pending[verificationIndex]!.resolve(
      revise(runtime.requests[verificationIndex]!, "blocker", issue),
    );
    yield* Effect.promise(() => tick());
    return verificationIndex;
  });

describe("persistent extension cutover", () => {
  it.effect("completed turns await only their correlated Advisor settlement", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      let settled = false;
      const turn = value.emitAwait("turn_end", finalTurn("held until review"));
      void turn.then(() => {
        settled = true;
      });
      yield* Effect.promise(() => tick());
      expect(settled).toBe(false);
      const current = value.runtimes[0]!;
      expect(current.requests).toHaveLength(1);
      current.pending[0]!.resolve(pass(current.requests[0]!));
      yield* invoke(turn);
      expect(settled).toBe(true);
      // SAFETY: This probes the intentionally absent command-only waitForIdle member on an event context.
      expect((value.ctx as { waitForIdle?: unknown }).waitForIdle).toBeUndefined();
    }),
  );

  it.effect("shutdown interrupts the direct final catch-up wait", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      let settled = false;
      const turn = value.emitAwait("turn_end", finalTurn("interrupted by shutdown"));
      void turn.then(() => {
        settled = true;
      });
      yield* Effect.promise(() => tick());
      expect(value.runtimes[0]!.requests).toHaveLength(1);
      expect(settled).toBe(false);

      yield* invoke(value.emit("session_shutdown", { type: "session_shutdown" }));
      yield* invoke(turn);

      expect(settled).toBe(true);
      expect(value.runtimes[0]!.driver.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    "cursor rewrite restart and checkpoint both remain inside the same catch-up barrier",
    () =>
      Effect.gen(function* () {
        const value = harness();
        yield* invoke(value.emit("session_start", { type: "session_start" }));
        // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
        (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
          {
            id: "replacement",
            type: "message",
            parentId: null,
            timestamp: "now",
            message: { role: "user", content: "replacement" },
          },
        ]);
        let settled = false;
        const turn = value.emitAwait("turn_end", finalTurn("must be reviewed after reseed"));
        void turn.then(() => {
          settled = true;
        });
        yield* Effect.promise(() => tick());

        expect(value.runtimes).toHaveLength(2);
        expect(value.runtimes[1]!.requests).toHaveLength(1);
        expect(settled).toBe(false);
        value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
        yield* invoke(turn);
        expect(settled).toBe(true);
      }),
  );

  it.effect("shows and cancels a delayed cursor restart without late delivery", () =>
    Effect.gen(function* () {
      const restart = deferred<void>();
      const value = harness({}, { runtimeStartPromises: [undefined, restart.promise] });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
      (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "replacement",
          type: "message",
          parentId: null,
          timestamp: "now",
          message: { role: "user", content: "replacement branch" },
        },
      ]);
      const turn = value.emitAwait("turn_end", finalTurn("cancel during restart"));
      yield* yieldUntil(() => value.runtimes.length === 2);

      // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
      yield* invoke(value.commands.get("advisor")!.handler("", value.ctx as never));
      expect(value.ctx.ui.select).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.arrayContaining(["Cancel review"]),
      );
      // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));
      yield* invoke(turn);
      restart.resolve();
      yield* Effect.promise(() => tick());
      // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));

      expect(value.runtimes[1]!.requests).toHaveLength(0);
      expect(value.runtimes[1]!.driver.dispose).toHaveBeenCalledOnce();
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not adopt newer user work while a cursor restart is yielding", () =>
    Effect.gen(function* () {
      const restart = deferred<void>();
      const value = harness({}, { runtimeStartPromises: [undefined, restart.promise] });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
      (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "replacement",
          type: "message",
          parentId: null,
          timestamp: "now",
          message: { role: "user", content: "replacement branch" },
        },
      ]);
      const turn = value.emitAwait("turn_end", finalTurn("old request"));
      yield* Effect.promise(() => tick());
      expect(value.runtimes).toHaveLength(2);

      yield* invoke(
        value.emit("message_end", {
          type: "message_end",
          message: { role: "user", content: "new request during restart" },
        }),
      );
      restart.resolve();
      yield* invoke(turn);
      yield* Effect.promise(() => tick());

      expect(value.runtimes[1]!.requests).toHaveLength(0);
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("provider failure, runtime reset, and parent cancellation release catch-up early", () =>
    Effect.gen(function* () {
      const provider = harness();
      yield* invoke(provider.emit("session_start", { type: "session_start" }));
      const providerTurn = provider.emitAwait("turn_end", finalTurn("provider failure"));
      yield* Effect.promise(() => tick());
      provider.runtimes[0]!.pending[0]!.reject(new Error("provider unavailable"));
      yield* invoke(providerTurn);

      const reset = harness();
      yield* invoke(reset.emit("session_start", { type: "session_start" }));
      const resetTurn = reset.emitAwait("turn_end", finalTurn("reset"));
      yield* Effect.promise(() => tick());
      yield* invoke(reset.emit("session_tree", { type: "session_tree" }));
      yield* invoke(resetTurn);

      const cancelled = harness();
      const controller = new AbortController();
      // SAFETY: The host signal is readonly to consumers; the fixture replaces it before starting the session.
      (cancelled.ctx as { signal: AbortSignal }).signal = controller.signal;
      yield* invoke(cancelled.emit("session_start", { type: "session_start" }));
      const cancelledTurn = cancelled.emitAwait("turn_end", finalTurn("cancelled"));
      yield* Effect.promise(() => tick());
      controller.abort();
      yield* invoke(cancelledTurn);
      const current = cancelled.runtimes[0]!;
      current.pending[0]!.resolve(
        revise(current.requests[0]!, "blocker", "must not surprise-resume"),
      );
      yield* Effect.promise(() => tick());
      expect(cancelled.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["authentication", "timeout"] as const)(
    "classifies typed %s startup failures without message heuristics",
    (kind) =>
      Effect.gen(function* () {
        const value = harness(
          {},
          {
            runtimeStartError: new AdvisorModelError({
              message: "opaque child startup failure",
              kind,
            }),
          },
        );

        yield* invoke(value.emit("session_start", { type: "session_start" }));

        expect(value.ctx.ui.notify).toHaveBeenCalledWith(
          `Advisor ${kind} failure; primary work remains unaffected.`,
          "warning",
        );
        expect(
          vi
            .mocked(value.ctx.ui.notify)
            .mock.calls.some((call) => String(call[0]).includes("provider failure")),
        ).toBe(false);
      }),
  );

  it.effect("abort dispatch synchronously defeats a same-tick provider completion", () =>
    Effect.gen(function* () {
      const value = harness();
      const controller = new AbortController();
      // SAFETY: The host signal is readonly to consumers; the fixture replaces it before starting the session.
      (value.ctx as { signal: AbortSignal }).signal = controller.signal;
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const turn = value.emitAwait("turn_end", finalTurn("racy candidate"));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;

      current.pending[0]!.resolve(revise(current.requests[0]!, "blocker", "racy blocker"));
      controller.abort();
      yield* invoke(turn);
      yield* Effect.promise(() => tick());

      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(value.appended.at(-1)).toMatchObject({
        routing: { cancellationLatched: true },
      });
    }),
  );

  it.effect("ingests thinking synchronously and serializes checkpoints without cancellation", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_start", { type: "turn_start", turnIndex: 1 }));
      for (let index = 0; index < 1_000; index += 1) {
        yield* invoke(
          value.emit("message_update", {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: `chunk-${index};` },
          }),
        );
      }
      yield* invoke(value.emit("turn_end", finalTurn("first")));
      yield* invoke(value.emit("turn_end", finalTurn("second")));
      yield* Effect.promise(() => tick());

      const current = value.runtimes[0];
      if (!current) throw new Error("runtime not created");
      expect(current.requests).toHaveLength(1);
      expect(current.requests[0]?.observations).toContain("assistant_thinking_delta");
      expect(current.driver.abort).not.toHaveBeenCalled();
      current.pending[0]?.resolve(pass(current.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(current.requests).toHaveLength(2);
      current.pending[1]?.resolve(pass(current.requests[1]!));
      yield* Effect.promise(() => tick());
      yield* Effect.promise(() => tick());
      expect(value.appended).toHaveLength(2);
    }),
  );

  it.effect("keeps separately registered advisor factories runtime-isolated", () =>
    Effect.gen(function* () {
      const first = harness();
      const second = harness();
      yield* Effect.promise(() =>
        Promise.all([
          first.emit("session_start", { type: "session_start" }),
          second.emit("session_start", { type: "session_start" }),
        ]),
      );
      yield* invoke(first.emit("session_shutdown", { type: "session_shutdown" }));
      yield* invoke(second.emit("session_tree", { type: "session_tree" }));

      expect(first.runtimes).toHaveLength(1);
      expect(first.runtimes[0]!.driver.dispose).toHaveBeenCalledOnce();
      expect(second.runtimes).toHaveLength(2);
      expect(second.runtimes[1]!.driver.start).toHaveBeenCalledOnce();
    }),
  );

  it.effect("starts once per parent session and disposes on shutdown", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const current = value.runtimes[0];
      expect(current?.driver.start).toHaveBeenCalledOnce();
      yield* invoke(value.emit("session_shutdown", { type: "session_shutdown" }));
      expect(current?.driver.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("a failed replacement capture shuts down the prior application exactly once", () =>
    Effect.gen(function* () {
      const value = harness();
      const cancellation = trackedAbortSignal();
      // SAFETY: The host signal is readonly to consumers; the fixture replaces it before starting the session.
      (value.ctx as { signal: AbortSignal }).signal = cancellation.signal;
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const current = value.runtimes[0]!;
      expect(cancellation.liveListeners()).toHaveLength(2);

      // SAFETY: The object inherits all fixture context capabilities before overriding cwd with a hostile getter.
      const invalidContext = Object.create(value.ctx) as ExtensionContext;
      Object.defineProperty(invalidContext, "cwd", {
        configurable: true,
        get: () => {
          throw new Error("guarded cwd unavailable");
        },
      });
      yield* Effect.promise(() =>
        expect(
          value.emitWithContext("session_start", { type: "session_start" }, invalidContext),
        ).resolves.toBeUndefined(),
      );
      yield* Effect.promise(() =>
        expect(
          value.emitWithContext("session_start", { type: "session_start" }, invalidContext),
        ).resolves.toBeUndefined(),
      );

      expect(value.runtimes).toHaveLength(1);
      expect(current.driver.dispose).toHaveBeenCalledOnce();
      expectAbortListenersReleasedExactlyOnce(cancellation);
      yield* invoke(value.emit("turn_end", finalTurn("must not reach the disposed application")));
      yield* Effect.promise(() => tick());
      expect(current.requests).toHaveLength(0);
      cancellation.abort();
      yield* Effect.promise(() => tick());
      expect(current.driver.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("valid replacement disposes the old Layer and its committed abort listener", () =>
    Effect.gen(function* () {
      const value = harness();
      const firstCancellation = trackedAbortSignal();
      const secondCancellation = trackedAbortSignal();
      // SAFETY: The host signal is readonly to consumers; the fixture replaces it before starting the session.
      (value.ctx as { signal: AbortSignal }).signal = firstCancellation.signal;
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const firstRuntime = value.runtimes[0]!;
      expect(firstCancellation.liveListeners()).toHaveLength(2);

      // SAFETY: The object inherits all fixture context capabilities before overriding the signal getter.
      const replacementContext = Object.create(value.ctx) as ExtensionContext;
      Object.defineProperty(replacementContext, "signal", {
        configurable: true,
        value: secondCancellation.signal,
      });
      yield* invoke(
        value.emitWithContext("session_start", { type: "session_start" }, replacementContext),
      );

      expect(value.runtimes).toHaveLength(2);
      expect(firstRuntime.driver.dispose).toHaveBeenCalledOnce();
      expectAbortListenersReleasedExactlyOnce(firstCancellation);
      expect(secondCancellation.liveListeners()).toHaveLength(2);

      firstCancellation.abort();
      yield* Effect.promise(() => tick());
      expect(value.runtimes[1]!.driver.dispose).not.toHaveBeenCalled();

      secondCancellation.abort();
      yield* Effect.promise(() => tick());
      yield* Effect.promise(() => tick());
      expect(value.runtimes[1]!.driver.dispose).toHaveBeenCalledOnce();
      expectAbortListenersReleasedExactlyOnce(secondCancellation);
    }),
  );

  it.effect("Layer replacement invalidates active checkpoint failure effects before cleanup", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const oldTurn = value.emitAwait("turn_end", finalTurn("active during replacement"));
      yield* Effect.promise(() => tick());
      expect(value.runtimes[0]!.requests).toHaveLength(1);
      vi.mocked(value.ctx.ui.notify).mockClear();
      vi.mocked(value.ctx.ui.setStatus).mockClear();

      yield* invoke(value.emitWithContext("session_start", { type: "session_start" }, value.ctx));
      yield* invoke(oldTurn);
      value.runtimes[0]!.pending[0]!.reject(
        new AdvisorModelError({ message: "authentication failed", kind: "authentication" }),
      );
      yield* Effect.promise(() => tick());

      expect(value.logFailure).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(value.ctx.ui.notify)
          .mock.calls.some((call) => String(call[0]).includes("failure")),
      ).toBe(false);
      expect(
        vi
          .mocked(value.ctx.ui.setStatus)
          .mock.calls.some((call) => String(call[1]).includes("unavailable")),
      ).toBe(false);
      expect(value.runtimes[1]!.driver.dispose).not.toHaveBeenCalled();
    }),
  );

  it.effect("ignores diagnostics from stale runtimes and replaced application Layers", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const firstDiagnostic = runtimeDiagnostic(value.runtimes[0]!);
      firstDiagnostic("current diagnostic");
      firstDiagnostic("current diagnostic");
      expect(value.ctx.ui.notify).toHaveBeenCalledTimes(1);

      yield* invoke(value.emit("session_tree", { type: "session_tree" }));
      const secondDiagnostic = runtimeDiagnostic(value.runtimes[1]!);
      vi.mocked(value.ctx.ui.notify).mockClear();
      firstDiagnostic("stale runtime diagnostic");
      expect(value.ctx.ui.notify).not.toHaveBeenCalled();
      secondDiagnostic("current replacement diagnostic");
      expect(value.ctx.ui.notify).toHaveBeenCalledWith("current replacement diagnostic", "warning");

      yield* invoke(value.emitWithContext("session_start", { type: "session_start" }, value.ctx));
      const thirdDiagnostic = runtimeDiagnostic(value.runtimes[2]!);
      vi.mocked(value.ctx.ui.notify).mockClear();
      secondDiagnostic("replaced Layer diagnostic");
      expect(value.ctx.ui.notify).not.toHaveBeenCalled();
      thirdDiagnostic("new Layer diagnostic");
      expect(value.ctx.ui.notify).toHaveBeenCalledWith("new Layer diagnostic", "warning");
    }),
  );

  it.effect("throwing status UI cannot skip child shutdown disposal", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const current = value.runtimes[0]!;
      vi.mocked(value.ctx.ui.setStatus).mockImplementation(() => {
        throw new Error("status failed");
      });

      yield* Effect.promise(() =>
        expect(
          value.emit("session_shutdown", { type: "session_shutdown" }),
        ).resolves.toBeUndefined(),
      );
      expect(current.driver.dispose).toHaveBeenCalledOnce();
    }),
  );

  it.effect("serializes overlapping child replacements behind prior disposal", () =>
    Effect.gen(function* () {
      const disposal = deferred<void>();
      const value = harness({}, { runtimeDisposePromises: [disposal.promise, undefined] });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const first = value.runtimes[0]!;

      const tree = value.emitAwait("session_tree", { type: "session_tree" });
      yield* Effect.promise(() => tick());
      const compact = value.emitAwait("session_compact", { type: "session_compact" });
      yield* Effect.promise(() => tick());
      expect(value.runtimes).toHaveLength(1);
      expect(first.driver.dispose).toHaveBeenCalledOnce();

      disposal.resolve();
      yield* Effect.promise(() => Promise.all([tree, compact]));
      expect(value.runtimes).toHaveLength(2);
      expect(value.runtimes[1]!.driver.start).toHaveBeenCalledOnce();
    }),
  );

  it.effect.each(["session_tree", "session_compact"])(
    "%s invalidation discards an old-epoch completion and re-primes",
    (eventName) =>
      Effect.gen(function* () {
        const value = harness();
        yield* invoke(value.emit("session_start", { type: "session_start" }));
        yield* invoke(value.emit("turn_end", finalTurn("old branch")));
        yield* Effect.promise(() => tick());
        const old = value.runtimes[0];
        if (!old?.requests[0]) throw new Error("missing checkpoint");
        yield* invoke(value.emit(eventName, { type: eventName }));
        old.pending[0]?.resolve(pass(old.requests[0]));
        yield* Effect.promise(() => tick());

        expect(value.runtimes).toHaveLength(2);
        expect(old.driver.dispose).toHaveBeenCalled();
        expect(value.sendMessage).not.toHaveBeenCalled();
        expect(value.appended).toHaveLength(0);
        if (eventName === "session_tree") {
          // SAFETY: The review command uses the fixture session and UI callbacks, not command navigation capabilities.
          yield* invoke(value.commands.get("advisor")!.handler("review", value.ctx as never));
          yield* Effect.promise(() => tick());
          expect(value.runtimes[1]?.requests).toHaveLength(0);
        }
      }),
  );

  it.effect("detects an unannounced parent-prefix replacement at a checkpoint boundary", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
      (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "replacement",
          type: "message",
          parentId: null,
          timestamp: "now",
          message: { role: "user", content: "replacement" },
        },
      ]);
      yield* invoke(value.emit("turn_end", finalTurn("new prefix")));
      yield* Effect.promise(() => tick());
      expect(value.runtimes).toHaveLength(2);
      expect(value.runtimes[0]?.driver.dispose).toHaveBeenCalled();
      expect(value.runtimes[0]?.requests).toHaveLength(0);
      expect(value.runtimes[1]?.requests).toHaveLength(1);
      value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("advances the processed anchor and detects a shared-prefix sibling rewrite", () =>
    Effect.gen(function* () {
      const value = harness();
      const root = {
        id: "root",
        type: "message",
        parentId: null,
        timestamp: "now",
        message: { role: "user", content: "root" },
      };
      const firstLeaf = {
        id: "first-leaf",
        type: "message",
        parentId: "root",
        timestamp: "now",
        message: { role: "assistant", content: "first" },
      };
      // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
      (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
        root,
        firstLeaf,
      ]);
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("checkpoint on first sibling")));
      yield* Effect.promise(() => tick());
      const firstRuntime = value.runtimes[0]!;
      firstRuntime.pending[0]!.resolve(pass(firstRuntime.requests[0]!));
      yield* Effect.promise(() => tick());

      // SAFETY: Branch restoration reads IDs, ancestry, and message content; these partial messages omit provider metadata.
      (value.ctx.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
        root,
        { ...firstLeaf, id: "second-leaf", message: { role: "assistant", content: "second" } },
      ]);
      yield* invoke(value.emit("turn_end", finalTurn("checkpoint on sibling")));
      yield* Effect.promise(() => tick());

      expect(value.runtimes).toHaveLength(2);
      expect(firstRuntime.driver.dispose).toHaveBeenCalledOnce();
      expect(value.runtimes[1]!.requests).toHaveLength(1);
      value.runtimes[1]!.pending[0]!.resolve(pass(value.runtimes[1]!.requests[0]!));
      yield* Effect.promise(() => tick());
    }),
  );

  it.effect("stale provider success settles discarded exactly once", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const turn = value.emitAwait("turn_end", finalTurn("stale success"));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;

      yield* invoke(
        value.emit("message_end", {
          type: "message_end",
          message: { role: "user", content: "newer request" },
        }),
      );
      current.pending[0]!.resolve(revise(current.requests[0]!));
      yield* invoke(turn);
      yield* Effect.promise(() => tick());

      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(value.ctx.abort).not.toHaveBeenCalled();
      expect(yield* usageSnapshot(value)).toContain("Responses/reviews/cards: 0 / 1 / 0");
    }),
  );

  it.effect(
    "stale authentication rejection has no failure side effects while current rejection stops",
    () =>
      Effect.gen(function* () {
        const stale = harness();
        yield* invoke(stale.emit("session_start", { type: "session_start" }));
        const staleTurn = stale.emitAwait("turn_end", finalTurn("stale authentication"));
        yield* Effect.promise(() => tick());
        yield* invoke(
          stale.emit("message_end", {
            type: "message_end",
            message: { role: "user", content: "new request" },
          }),
        );
        stale.runtimes[0]!.pending[0]!.reject(
          new AdvisorModelError({ message: "opaque stale rejection", kind: "authentication" }),
        );
        yield* invoke(staleTurn);
        yield* Effect.promise(() => tick());

        expect(stale.logFailure).not.toHaveBeenCalled();
        expect(stale.runtimes[0]!.driver.dispose).not.toHaveBeenCalled();
        expect(
          vi
            .mocked(stale.ctx.ui.setStatus)
            .mock.calls.some((call) => String(call[1]).includes("unavailable")),
        ).toBe(false);
        expect(
          vi
            .mocked(stale.ctx.ui.notify)
            .mock.calls.some((call) => String(call[0]).includes("failure")),
        ).toBe(false);

        const current = harness();
        yield* invoke(current.emit("session_start", { type: "session_start" }));
        const currentTurn = current.emitAwait("turn_end", finalTurn("current authentication"));
        yield* Effect.promise(() => tick());
        current.runtimes[0]!.pending[0]!.reject(
          new AdvisorModelError({ message: "authentication failed", kind: "authentication" }),
        );
        yield* invoke(currentTurn);
        yield* yieldUntil(
          () =>
            current.runtimes[0]!.driver.dispose.mock.calls.length === 1 &&
            current.logFailure.mock.calls.length === 1,
        );

        expect(current.logFailure).toHaveBeenCalledOnce();
        expect(current.runtimes[0]!.driver.dispose).toHaveBeenCalledOnce();
        expect(
          vi
            .mocked(current.ctx.ui.setStatus)
            .mock.calls.some((call) => String(call[1]).includes("unavailable")),
        ).toBe(true);
      }),
  );

  it.effect(
    "a committed config invalidates an admitted checkpoint without a revision counter",
    () =>
      Effect.gen(function* () {
        const value = harness({}, { memoryConfig: true });
        yield* invoke(value.emit("session_start", { type: "session_start" }));
        const turn = value.emitAwait("turn_end", finalTurn("old config"));
        yield* Effect.promise(() => tick());
        const current = value.runtimes[0]!;

        // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
        yield* invoke(value.commands.get("advisor")!.handler("off", value.ctx as never));
        current.pending[0]!.resolve(revise(current.requests[0]!));
        yield* invoke(turn);
        yield* Effect.promise(() => tick());

        expect(value.sendMessage).not.toHaveBeenCalled();
        expect(value.ctx.abort).not.toHaveBeenCalled();
      }),
  );

  it.effect("cancellation and late completion record one review settlement", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      const turn = value.emitAwait("turn_end", finalTurn("cancel once"));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;

      // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));
      yield* invoke(turn);
      current.pending[0]!.resolve(revise(current.requests[0]!));
      yield* Effect.promise(() => tick());
      // SAFETY: This locally constructed command fixture satisfies the Pi command context contract.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));

      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(yield* usageSnapshot(value)).toContain("Responses/reviews/cards: 0 / 1 / 0");
    }),
  );

  it.effect("suppresses delivery when user input is queued", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0];
      if (!current?.requests[0]) throw new Error("missing checkpoint");
      vi.mocked(value.ctx.hasPendingMessages).mockReturnValue(true);
      current.pending[0]?.resolve(revise(current.requests[0]));
      yield* Effect.promise(() => tick());
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "does not recursively observe an advisor review custom message as genuine user work",
    () =>
      Effect.gen(function* () {
        const value = harness();
        yield* invoke(value.emit("session_start", { type: "session_start" }));
        yield* invoke(
          value.emit("message_end", {
            type: "message_end",
            message: { role: "custom", customType: "advisor-review", content: "critique" },
          }),
        );
        yield* invoke(value.emit("turn_end", finalTurn("answer")));
        yield* Effect.promise(() => tick());
        const request = value.runtimes[0]?.requests[0];
        expect(request?.observations).not.toContain("critique");
      }),
  );

  it.effect("steers an active parent without triggering a synthetic turn", () =>
    Effect.gen(function* () {
      const value = harness();
      vi.mocked(value.ctx.isIdle).mockReturnValue(false);
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      yield* resolveVerifiedBlocker(current, 0);
      expect(value.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "steer" });
      expect(value.ctx.abort).not.toHaveBeenCalled();
    }),
  );

  it.effect("suppresses a late blocker after an external abort without waking the parent", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      yield* invoke(
        value.emit("turn_end", {
          ...finalTurn(""),
          message: { role: "assistant", content: [], stopReason: "aborted" },
        }),
      );
      current.pending[0]!.resolve(revise(current.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(value.ctx.abort).not.toHaveBeenCalled();
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("cancel stops in-flight work without late delivery", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      // SAFETY: Cancel uses the fixture runtime controls and notification callback only.
      yield* invoke(value.commands.get("advisor")!.handler("cancel", value.ctx as never));
      current.pending[0]!.resolve(revise(current.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("requires a correlated second pass before delivering a high-confidence blocker", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      const initial = confidentBlocker(current.requests[0]!);
      current.pending[0]!.resolve(initial);
      yield* Effect.promise(() => tick());

      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(current.requests[1]?.focus).toBe("blocker-verification");
      expect(current.requests[1]?.verificationReview?.findings).toEqual(initial.findings);
      current.pending[1]!.resolve(confidentBlocker(current.requests[1]!));
      yield* Effect.promise(() => tick());

      expect(value.sendMessage).toHaveBeenCalledOnce();
      expect(value.sendMessage.mock.lastCall?.[1]).toEqual({
        deliverAs: "steer",
        triggerTurn: true,
      });
    }),
  );

  it.effect("drops an unconfirmed blocker without disturbing the primary response", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(confidentBlocker(current.requests[0]!));
      yield* Effect.promise(() => tick());
      current.pending[1]!.resolve(pass(current.requests[1]!));
      yield* Effect.promise(() => tick());

      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(value.ctx.abort).not.toHaveBeenCalled();
    }),
  );

  it.effect("persists the reset intervention budget at a genuine request boundary", () =>
    Effect.gen(function* () {
      const value = harness();
      vi.mocked(value.ctx.isIdle).mockReturnValue(false);
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(revise(current.requests[0]!, "concern", "budgeted issue"));
      yield* Effect.promise(() => tick());
      expect(value.appended.at(-1)).toMatchObject({
        routing: { interventionBudget: { delivered: 1 } },
      });

      yield* invoke(
        value.emit("message_end", {
          type: "message_end",
          message: { role: "user", content: "new request" },
        }),
      );
      expect(value.appended.at(-1)).toMatchObject({
        routing: { interventionBudget: { delivered: 0, correctionUsed: false } },
      });
    }),
  );

  it.effect("keeps lifecycle identity stable across restart without a session ID", () =>
    Effect.gen(function* () {
      const first = harness({}, { withoutSessionId: true });
      vi.mocked(first.ctx.isIdle).mockReturnValue(false);
      yield* invoke(first.emit("session_start", { type: "session_start" }));
      yield* invoke(first.emit("turn_end", finalTurn("first candidate")));
      yield* Effect.promise(() => tick());
      const initial = first.runtimes[0]!;
      initial.pending[0]!.resolve(revise(initial.requests[0]!, "concern", "stable fallback issue"));
      yield* Effect.promise(() => tick());
      // SAFETY: The checkpoint writer appended this ledger; this assertion inspects only finding IDs and statuses.
      const firstLedger = first.appended.at(-1) as {
        findingLifecycle: Array<{ id: string; status: string }>;
      };
      const findingId = firstLedger.findingLifecycle[0]!.id;
      for (const entry of first.branch) {
        if (entry.type === "custom" && hasObjectRuntimeType(entry.data) && entry.data) {
          // SAFETY: The custom-entry data is an object; clearing emission hashes simulates a ledger without prior delivery.
          (entry.data as { emissionHashes?: string[] }).emissionHashes = [];
        }
      }

      const second = harness(
        {},
        {
          branch: first.branch,
          withoutSessionId: true,
        },
      );
      yield* invoke(second.emit("session_start", { type: "session_start" }));
      yield* invoke(second.emit("turn_end", finalTurn("second candidate")));
      yield* Effect.promise(() => tick());
      const restored = second.runtimes[0]!;
      restored.pending[0]!.resolve(
        revise(restored.requests[0]!, "concern", "stable fallback issue"),
      );
      yield* Effect.promise(() => tick());

      expect(second.sendMessage).not.toHaveBeenCalled();
      expect(second.appended.at(-1)).toMatchObject({
        findingLifecycle: [expect.objectContaining({ id: findingId, status: "acknowledged" })],
      });
    }),
  );

  it.effect.each(["aborted", "error", "length"] as const)(
    "skips incomplete %s turns",
    (stopReason) =>
      Effect.gen(function* () {
        const value = harness();
        yield* invoke(value.emit("session_start", { type: "session_start" }));
        yield* invoke(
          value.emit("turn_end", {
            ...finalTurn("incomplete"),
            message: { ...finalTurn("incomplete").message, stopReason },
          }),
        );
        yield* Effect.promise(() => tick());
        expect(value.runtimes[0]?.requests).toHaveLength(0);
      }),
  );

  it.effect("disabled review does not start child work or review turns", () =>
    Effect.gen(function* () {
      const value = harness({ enabled: false });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      expect(value.runtimes).toHaveLength(0);
    }),
  );

  it.effect("queued user input still runs mandatory catch-up but suppresses stale delivery", () =>
    Effect.gen(function* () {
      const value = harness();
      vi.mocked(value.ctx.hasPendingMessages).mockReturnValue(true);
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("obsolete")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      expect(current.requests).toHaveLength(1);
      current.pending[0]!.resolve(revise(current.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(value.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("successful pass checkpoints remain silent while persisting compact state", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve(pass(current.requests[0]!));
      yield* Effect.promise(() => tick());
      expect(value.sendMessage).not.toHaveBeenCalled();
      expect(value.appended).toHaveLength(1);
    }),
  );

  it.effect("never copies model-authored checkpoint state into the durable ledger", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const current = value.runtimes[0]!;
      current.pending[0]!.resolve({
        ...pass(current.requests[0]!),
        stateSummary: "COPIED_TRANSCRIPT_73af private thinking /secret/file sk-abcdefghijklmnop",
        summary: "COPIED_TRANSCRIPT_73af",
      });
      yield* Effect.promise(() => tick());

      expect(serializedSnapshot(value.appended[0])).not.toMatch(
        /COPIED_TRANSCRIPT_73af|private thinking|secret\/file|sk-abcdefghijklmnop/,
      );
      expect(value.appended[0]).toMatchObject({
        reviewSummary: { verdict: "pass" },
      });
    }),
  );

  it.effect("logs checkpoint failures and emits a rate-limited warning", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      value.runtimes[0]!.pending[0]!.reject(new Error("provider failure"));
      yield* Effect.promise(() => tick());
      expect(value.logFailure).toHaveBeenCalledOnce();
      expect(value.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("keeping the primary response"),
        "warning",
      );

      yield* invoke(value.emit("turn_end", finalTurn("second candidate")));
      yield* Effect.promise(() => tick());
      value.runtimes[0]!.pending[1]!.reject(new Error("provider failed again"));
      yield* Effect.promise(() => tick());
      const failureWarnings = vi
        .mocked(value.ctx.ui.notify)
        .mock.calls.filter(
          ([message, level]) =>
            level === "warning" && String(message).includes("keeping the primary response"),
        );
      expect(failureWarnings).toHaveLength(1);
      expect(value.logFailure).toHaveBeenCalledTimes(2);
    }),
  );

  test("does not show a late spinner when a checkpoint settles within the delay", () => {
    vi.useFakeTimers();
    const value = harness();
    return value
      .emit("session_start", { type: "session_start" })
      .then(() => value.emit("turn_end", finalTurn("candidate")))
      .then(() => vi.advanceTimersByTimeAsync(0))
      .then(() => {
        const current = value.runtimes[0]!;
        current.pending[0]!.resolve(pass(current.requests[0]!));
        return vi.advanceTimersByTimeAsync(500);
      })
      .then(() => {
        const setStatus = vi.mocked(value.ctx.ui.setStatus);
        expect(setStatus.mock.calls.some((call) => String(call[1]).includes("advising"))).toBe(
          false,
        );
      })
      .finally(() => {
        vi.useRealTimers();
      });
  });

  it.effect("manual review cannot start unmanaged work after shutdown or a tree callback", () =>
    Effect.gen(function* () {
      const value = harness({}, { runtimeStartPromises: [undefined] });
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("candidate")));
      yield* Effect.promise(() => tick());
      const initial = value.runtimes[0]!;
      initial.pending[0]!.resolve(pass(initial.requests[0]!));
      yield* Effect.promise(() => tick());
      yield* invoke(value.emit("session_shutdown", { type: "session_shutdown" }));
      const command = value.commands.get("advisor")!;
      const notify = vi.mocked(value.ctx.ui.notify);
      notify.mockClear();

      // SAFETY: The review command uses the fixture session and UI callbacks, not command navigation capabilities.
      const review = command.handler("review", value.ctx as never);
      yield* Effect.promise(() => tick());
      expect(value.runtimes).toHaveLength(1);
      yield* invoke(value.emit("session_tree", { type: "session_tree" }));
      expect(value.runtimes).toHaveLength(1);
      yield* invoke(review);
      yield* Effect.promise(() => tick());

      expect(value.runtimes[0]!.requests).toHaveLength(1);
      expect(notify).not.toHaveBeenCalledWith(
        "No completed response is available to review.",
        "warning",
      );
    }),
  );

  test("cleans trajectory timers when newer user work supersedes the active turn", () => {
    vi.useFakeTimers();
    const value = harness();
    return value
      .emit("session_start", { type: "session_start" })
      .then(() => value.emit("turn_start", { type: "turn_start", turnIndex: 1 }))
      .then(() => value.emit("message_end", { message: { role: "user", content: "new work" } }))
      .then(() => vi.advanceTimersByTimeAsync(100_000))
      .then(() => {
        expect(value.runtimes[0]?.requests).toHaveLength(0);
      })
      .finally(() => {
        vi.useRealTimers();
      });
  });

  it.effect("uses turn_start as the sole parent-turn increment in Pi message ordering", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(
        value.emit("message_end", {
          type: "message_end",
          message: { role: "user", content: "ordered user" },
        }),
      );
      yield* invoke(value.emit("turn_start", { type: "turn_start", turnIndex: 1 }));
      yield* invoke(
        value.emit("message_update", {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "ordered assistant" },
        }),
      );
      yield* invoke(value.emit("turn_end", finalTurn("ordered final")));
      yield* Effect.promise(() => tick());
      const observations = value.runtimes[0]!.requests[0]!.observations;
      const records = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Array(Schema.Struct({ type: Schema.String, parentTurnId: Schema.Number })),
        ),
      )(observations.split("\n\n").at(-1)!);

      expect(records.find((record) => record.type === "user")?.parentTurnId).toBe(0);
      expect(records.find((record) => record.type === "assistant_text_delta")?.parentTurnId).toBe(
        1,
      );
      expect(records.find((record) => record.type === "assistant_final")?.parentTurnId).toBe(1);
      value.runtimes[0]!.pending[0]!.resolve(pass(value.runtimes[0]!.requests[0]!));
      yield* Effect.promise(() => tick());
    }),
  );

  it.effect("persists an external aborted turn cancellation across shutdown and restart", () =>
    Effect.gen(function* () {
      const first = harness();
      yield* invoke(first.emit("session_start", { type: "session_start" }));
      yield* invoke(first.emit("turn_end", finalTurn("baseline")));
      yield* Effect.promise(() => tick());
      first.runtimes[0]!.pending[0]!.resolve(pass(first.runtimes[0]!.requests[0]!));
      yield* Effect.promise(() => tick());
      yield* invoke(
        first.emit("turn_end", {
          ...finalTurn(""),
          message: { role: "assistant", content: [], stopReason: "aborted" },
        }),
      );
      expect(first.appended.at(-1)).toMatchObject({
        routing: { cancellationLatched: true },
      });
      yield* invoke(first.emit("session_shutdown", { type: "session_shutdown" }));

      const second = harness({}, { branch: first.branch });
      yield* invoke(second.emit("session_start", { type: "session_start" }));
      yield* invoke(second.emit("turn_end", finalTurn("after restart")));
      yield* Effect.promise(() => tick());
      const current = second.runtimes[0]!;
      current.pending[0]!.resolve(confidentBlocker(current.requests[0]!));
      yield* Effect.promise(() => tick());
      current.pending[1]!.resolve(confidentBlocker(current.requests[1]!));
      yield* Effect.promise(() => tick());
      expect(second.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("observes assistant_final before turn_complete in the checkpoint batch", () =>
    Effect.gen(function* () {
      const value = harness();
      yield* invoke(value.emit("session_start", { type: "session_start" }));
      yield* invoke(value.emit("turn_end", finalTurn("ordered")));
      yield* Effect.promise(() => tick());
      const observations = value.runtimes[0]?.requests[0]?.observations ?? "";
      expect(observations.indexOf("assistant_final")).toBeLessThan(
        observations.indexOf("turn_complete"),
      );
    }),
  );
});
