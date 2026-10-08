// Pi rebuilds history before session_start; those same rows adopt the first activation.
import { initTheme } from "@earendil-works/pi-coding-agent";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { CodePreviewSettings } from "pi-code-previews";
import {
  applyPresentationSettings,
  drawToolRow,
  hostToolRow,
  toolRowFrames,
} from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise, extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { ASYNC_MESSAGE_TYPE } from "../src/boundary/host-delivery.ts";
import { formatAskUserOutcome } from "../src/questionnaire/format.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import { startExtension, withoutRelayMarker, type MessageRenderer } from "./support/extension.ts";
import { asyncRequest, defaultQuestion } from "./support/questionnaire.ts";

beforeAll(() => initTheme("dark", false));

const restoreSettings = applyPresentationSettings({});
const snapshot = {
  requestId: "request-1",
  deliveryId: "delivery-1",
  status: "pending",
  presentation: "open",
  independentWork: "Inspect",
  blockedWork: "Choose",
  delivery: "pending",
} as const;
const names = ["ask_user", "ask_user_async", "ask_user_async_control"] as const;
type HistoryName = (typeof names)[number];
interface HistoryCall {
  readonly args: object;
  readonly text: string;
  readonly details: object;
}
const history = {
  ask_user: {
    args: { questions: [defaultQuestion] },
    text: "Choice: A\nFULL_ANSWER recovery /tmp/answer.txt",
    details: {
      outcome: "submitted",
      answers: [{ key: "choice", kind: "choices", values: ["a"], labels: ["A"] }],
    },
  },
  ask_user_async: {
    args: asyncRequest,
    text: "Request request-1 is pending.\nFULL_RECEIPT guidance /tmp/receipt.txt",
    details: snapshot,
  },
  ask_user_async_control: {
    args: { action: "status", requestId: "request-1" },
    text: "Request request-1 is pending.\nFULL_STATUS guidance /tmp/status.txt",
    details: { requests: [snapshot] },
  },
} satisfies Record<HistoryName, HistoryCall>;

const answered: AskUserOutcome = {
  outcome: "submitted",
  answers: [
    {
      key: "release",
      kind: "choices",
      values: ["release_candidate"],
      labels: ["Staged rollout"],
      note: "Keep release reversible",
    },
    { key: "alternative", kind: "custom", text: "Keep existing clients supported" },
    {
      key: "summary",
      kind: "text",
      text: "Original answer first line\nOriginal answer final line",
      note: "Original note first line\nOriginal note final line",
    },
  ],
};
const answerMessage: Parameters<MessageRenderer>[0] = {
  role: "custom",
  customType: ASYNC_MESSAGE_TYPE,
  content: `${formatAskUserOutcome(answered)}\nRAW_RECOVERY /tmp/answer-recovery.txt`,
  details: {
    requestId: "historical-request",
    deliveryId: "historical-delivery",
    generation: "historical-generation",
    outcome: answered,
  },
  display: true,
  timestamp: 0,
};
const drawAnswer = (render: MessageRenderer, message = answerMessage, expanded = false) =>
  render(message, { expanded, outputPad: 0 }, plainTheme)!.render(160).join("\n");

withoutRelayMarker();
afterEach(restoreSettings);

const context = (mode: "tui" | "rpc" | "print") =>
  extensionContextFixture({
    cwd: process.cwd(),
    hasUI: mode !== "print",
    mode,
    ui: { notify: vi.fn() },
    isProjectTrusted: () => false,
  });

/** Trusted settings load in startup, before activation wraps the tools. */
const loads = (settings: Partial<CodePreviewSettings>) => () => {
  applyPresentationSettings(settings);
  return Promise.resolve();
};

/** Actual factory callbacks, with rows Pi rebuilds from history through the public resolvers. */
const host = (load: () => Promise<void>) =>
  Effect.gen(function* () {
    const extension = yield* startExtension(load);
    const row = (name: HistoryName) => {
      const { args, text, details } = history[name];
      return hostToolRow(name, args, extension.resolve(name), {
        id: `${name}-call`,
        result: { content: [{ type: "text", text }], details, isError: false },
      });
    };
    return { ...extension, row };
  });

layer(nodeFilePlatformLayer)("ask-user history replay", (it) => {
  it.effect("historical answers render before startup and observe later presentation policy", () =>
    Effect.gen(function* () {
      applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
      const entered = deferredPromise();
      const ready = deferredPromise();
      const load = vi.fn(() => {
        entered.resolve();
        return ready.promise.then(() => {
          applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
        });
      });
      const h = yield* host(load);
      const ctx = context("tui");
      yield* Effect.addFinalizer(() => Effect.promise(() => h.emit("session_shutdown", ctx)));
      // Retain the actual factory callback, not a freshly registered tool renderer.
      const render = h.messageRenderers.get(ASYNC_MESSAGE_TYPE)!;
      expect(drawAnswer(render)).not.toContain("Staged rollout");
      expect(drawAnswer(render, answerMessage, true)).toContain("Staged rollout");
      expect(load).not.toHaveBeenCalled();
      expect([...h.tools.keys()]).toEqual([]);

      applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
      expect(drawAnswer(render)).toContain("Staged rollout");
      const starting = h.emit("session_start", ctx);
      yield* Effect.promise(() => entered.promise);
      expect(drawAnswer(render)).toContain("Keep release reversible");
      expect([...h.tools.keys()]).toEqual([]);

      ready.resolve();
      yield* Effect.promise(() => starting);
      expect(drawAnswer(render)).not.toContain("Staged rollout");
      expect(drawAnswer(render, answerMessage, true)).toContain("RAW_RECOVERY");
      applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
      expect(drawAnswer(render)).toContain("Staged rollout");
      // History needs neither the runtime nor delivery authority after shutdown.
      yield* Effect.promise(() => h.emit("session_shutdown", ctx));
      expect(drawAnswer(render)).toContain("Keep release reversible");
    }),
  );

  for (const style of ["compact", "preview"] as const)
    it.effect(
      `factory answer rendering preserves original content and raw recovery (${style})`,
      () =>
        Effect.gen(function* () {
          applyPresentationSettings({ toolCallCollapsedStyle: style });
          const h = yield* host(() => Promise.resolve());
          const render = h.messageRenderers.get(ASYNC_MESSAGE_TYPE)!;
          for (const content of [
            answerMessage.content,
            [{ type: "text" as const, text: String(answerMessage.content) }],
            "",
          ]) {
            const message = { ...answerMessage, content };
            const before = structuredClone(message);
            for (const expanded of [false, true, false, true]) {
              const text = drawAnswer(render, message, expanded);
              expect(text).not.toContain("historical-generation");
              if (expanded) {
                for (const value of [
                  "Staged rollout",
                  "Keep release reversible",
                  "Keep existing clients supported",
                  "Original answer first line",
                  "Original answer final line",
                  "Original note first line",
                  "Original note final line",
                ])
                  expect(text).toContain(value);
                if (content) {
                  expect(text).toContain("release_candidate");
                  expect(text).toContain("RAW_RECOVERY /tmp/answer-recovery.txt");
                }
              } else {
                expect(text.includes("Staged rollout")).toBe(style === "preview");
                expect(text).not.toContain("RAW_RECOVERY");
                expect(text).not.toContain("Original answer final line");
              }
            }
            expect(message).toEqual(before);
          }
          const malformed = { ...answerMessage, details: { outcome: "unknown" } };
          const fallback = drawAnswer(render, malformed, true);
          expect(fallback).toContain("Original note final line");
          expect(fallback).toContain("RAW_RECOVERY /tmp/answer-recovery.txt");
          expect([...h.tools.keys()]).toEqual([]);
        }),
    );

  for (const [mode, relay] of [
    ["rpc", false],
    ["print", false],
    ["tui", true],
    ["print", true],
  ] as const)
    it.effect(`answer replay does not widen tool exposure (${mode}, relay=${relay})`, () =>
      Effect.gen(function* () {
        if (relay) {
          vi.stubEnv("PI_SUBAGENT_CHILD", "1");
          vi.stubEnv("PI_SUBAGENT_RUN_ID", "child-run");
        }
        applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
        const h = yield* host(() => Promise.resolve());
        const ctx = context(mode);
        yield* Effect.addFinalizer(() => Effect.promise(() => h.emit("session_shutdown", ctx)));
        const render = h.messageRenderers.get(ASYNC_MESSAGE_TYPE)!;
        expect(drawAnswer(render)).toContain("Keep release reversible");
        expect([...h.tools.keys()]).toEqual([]);
        yield* Effect.promise(() => h.emit("session_start", ctx));
        expect(drawAnswer(render, answerMessage, true)).toContain("RAW_RECOVERY");
        expect([...h.tools.keys()]).toEqual(mode === "print" && !relay ? [] : ["ask_user"]);
      }),
    );

  // Code Previews proves every appearance; this proves the questionnaire tools adopt one.
  it.effect("TUI history from before startup adopts each questionnaire tool", () =>
    Effect.gen(function* () {
      const h = yield* host(
        loads({
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "border",
          toolCallTiming: false,
        }),
      );
      const rows = names.map((name) => ({ name, row: h.row(name) }));
      const cold = rows.map(({ row }) => drawToolRow(row));
      yield* Effect.promise(() => h.emit("session_start", context("tui")));
      expect(new Set(h.tools.keys())).toEqual(new Set(names));
      rows.forEach(({ name, row }, index) => {
        expect(drawToolRow(row)).not.toBe(cold[index]);
        // A row resolved after startup draws the registered tool's ordinary presentation.
        expect(toolRowFrames(row)).toEqual(toolRowFrames(h.row(name)));
        const expanded = drawToolRow(row, true);
        for (const line of history[name].text.split("\n")) expect(expanded).toContain(line);
      });
      expect(drawToolRow(rows[0]!.row, true)).toContain(defaultQuestion.prompt);
      expect(drawToolRow(rows[2]!.row, true)).toContain("request-1");
      yield* Effect.promise(() => h.emit("session_shutdown", context("tui")));
    }),
  );

  it.effect("RPC history adopts only the registered blocking tool; async rows stay raw", () =>
    Effect.gen(function* () {
      const h = yield* host(loads({ toolCallCollapsedStyle: "compact", toolCallTiming: false }));
      const rows = names.map((name) => h.row(name));
      const cold = rows.map((row) => toolRowFrames(row));
      yield* Effect.promise(() => h.emit("session_start", context("rpc")));
      expect([...h.tools.keys()]).toEqual(["ask_user"]);
      expect(toolRowFrames(rows[0]!)).toEqual(toolRowFrames(h.row("ask_user")));
      expect(toolRowFrames(rows[0]!)).not.toEqual(cold[0]);
      expect(rows.slice(1).map((row) => toolRowFrames(row))).toEqual(cold.slice(1));
      yield* Effect.promise(() => h.emit("session_shutdown", context("rpc")));
    }),
  );

  for (const failure of ["no UI", "tree replacement"] as const)
    it.effect(`history stays raw after ${failure} closes the first startup`, () =>
      Effect.gen(function* () {
        const entered = deferredPromise();
        let calls = 0;
        const h = yield* host(() => {
          if (++calls > 1 || failure === "no UI") return Promise.resolve();
          entered.resolve();
          return Promise.race([]);
        });
        const row = h.row("ask_user");
        const cold = toolRowFrames(row);
        if (failure === "no UI")
          yield* Effect.promise(() => h.emit("session_start", context("print")));
        else {
          // Tree navigation interrupts the first startup while trusted settings still load.
          const first = h.emit("session_start", context("tui"));
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(() => h.emit("session_tree", context("tui")));
          yield* Effect.promise(() => first);
        }
        // Later activations register normally but cannot publish into closed history.
        yield* Effect.promise(() => h.emit("session_tree", context("tui")));
        yield* Effect.promise(() => h.emit("session_start", context("tui")));
        expect(h.tools.has("ask_user")).toBe(true);
        expect(toolRowFrames(row)).toEqual(cold);
        yield* Effect.promise(() => h.emit("session_shutdown", context("tui")));
      }),
    );
});
