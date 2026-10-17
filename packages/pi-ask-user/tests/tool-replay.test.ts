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
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { startExtension, withoutRelayMarker } from "./support/extension.ts";
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

const loads = (settings: Partial<CodePreviewSettings>) => () => {
  applyPresentationSettings(settings);
  return Promise.resolve();
};

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
        expect(toolRowFrames(row)).toEqual(toolRowFrames(h.row(name)));
        const expanded = drawToolRow(row, true);
        for (const line of history[name].text.split("\n")) expect(expanded).toContain(line);
      });
      expect(drawToolRow(rows[0]!.row, true)).toContain(defaultQuestion.prompt);
      expect(drawToolRow(rows[2]!.row, true)).toContain("request-1");
      yield* Effect.promise(() => h.emit("session_shutdown", context("tui")));
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
          const first = h.emit("session_start", context("tui"));
          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(() => h.emit("session_tree", context("tui")));
          yield* Effect.promise(() => first);
        }
        yield* Effect.promise(() => h.emit("session_tree", context("tui")));
        yield* Effect.promise(() => h.emit("session_start", context("tui")));
        expect(h.tools.has("ask_user")).toBe(true);
        expect(toolRowFrames(row)).toEqual(cold);
        yield* Effect.promise(() => h.emit("session_shutdown", context("tui")));
      }),
    );
});
