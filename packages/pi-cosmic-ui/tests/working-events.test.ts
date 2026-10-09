import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import cosmicUi from "../index.ts";
import { eventBus, execOk } from "./support/host.ts";

/** Real registered handlers; only the row's clock/ticker and Pi I/O are replaced. */
const workingHost = Effect.gen(function* () {
  let time = 0;
  let message: string | undefined;
  let tick: (() => void) | undefined;
  let mode: "tui" | "rpc" = "tui";
  const host = recordingExtensionHost({}, { exec: () => execOk(), events: eventBus().events });
  const ctx = extensionContextFixture({
    cwd: process.cwd(),
    get mode() {
      return mode;
    },
    hasUI: true,
    isProjectTrusted: () => false,
    sessionManager: {
      getEntries: () => [],
      getCwd: () => process.cwd(),
      getSessionId: () => "working-test",
      getLeafId: () => null,
    },
    ui: {
      setFooter: () => {},
      setWidget: () => {},
      setWorkingMessage: (value?: string) => {
        message = value;
      },
      notify: () => {},
    },
  });
  cosmicUi(host.pi, {
    workingRow: {
      now: () => time,
      every: (_interval, callback) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
  });
  const emit = <EventInput>(name: string, event?: EventInput) =>
    Effect.promise(() => host.emit(name, ctx, event));
  yield* emit("session_start");
  yield* Effect.addFinalizer(() => emit("session_shutdown"));
  yield* emit("agent_start");
  return {
    emit,
    at: (milliseconds: number) => {
      time = milliseconds;
    },
    mode: (next: "tui" | "rpc") => {
      mode = next;
    },
    rate: () => {
      tick?.();
      // Observe the numeric measurement, not exact labels, punctuation or row layout.
      const value = message?.match(/(~?)([\d.]+) tok\/s/u);
      return value ? { approximate: value[1] === "~", value: Number(value[2]) } : undefined;
    },
  };
});

const completion = <OutputInput>(output: OutputInput, stopReason = "stop") => ({
  message: { role: "assistant", stopReason, usage: { output, reasoning: 100, input: 50_000 } },
});
const delta = (type: string, text: string) => ({ assistantMessageEvent: { type, delta: text } });

describe("working throughput through registered Pi events", () => {
  it.effect("starts before the first delta, then replaces the estimate with reported output", () =>
    Effect.gen(function* () {
      const h = yield* workingHost;
      yield* h.emit("context_with_system");
      h.at(10_000);
      yield* h.emit("message_start", { message: { role: "assistant" } });
      for (const type of ["text_delta", "thinking_delta", "toolcall_delta"])
        yield* h.emit("message_update", delta(type, "a".repeat(40)));
      yield* h.emit("message_update", delta("text_start", "ignored"));
      expect(h.rate()).toEqual({ approximate: true, value: 3 });
      yield* h.emit("message_end", completion(500));
      // reasoning is already in output; input/cache/tool tokens never enter the numerator.
      expect(h.rate()).toEqual({ approximate: false, value: 50 });
      h.at(50_000);
      yield* h.emit("tool_execution_start", { toolName: "read" });
      yield* h.emit("message_end", { message: { role: "toolResult", usage: { output: 90_000 } } });
      expect(h.rate()).toEqual({ approximate: false, value: 50 });
    }),
  );

  it.effect("does not confuse non-assistant messages or provider hooks with call boundaries", () =>
    Effect.gen(function* () {
      const h = yield* workingHost;
      yield* h.emit("before_provider_request", { payload: {} });
      h.at(1_000);
      yield* h.emit("message_end", completion(200));
      expect(h.rate()).toBeUndefined();
      yield* h.emit("context_with_system");
      h.at(2_000);
      yield* h.emit("before_provider_request", { payload: {} });
      yield* h.emit("message_end", { message: { role: "user" } });
      yield* h.emit("message_end", { message: { role: "custom" } });
      h.at(3_000);
      yield* h.emit("message_end", completion(200));
      expect(h.rate()).toEqual({ approximate: false, value: 100 });
    }),
  );

  it.effect(
    "excludes failed and unavailable samples without losing the last completed average",
    () =>
      Effect.gen(function* () {
        const h = yield* workingHost;
        yield* h.emit("context_with_system");
        h.at(1_000);
        yield* h.emit("message_end", completion(100));
        const unavailable = [
          ...["error", "aborted", "pending", "deferred"].map((stop) => completion(500, stop)),
          ...[undefined, 0, -1, Infinity, NaN, 1.5, "100"].map((output) => completion(output)),
          { message: { role: "assistant", stopReason: "stop" } },
          {
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: {
                get output() {
                  throw new Error("unavailable usage");
                },
              },
            },
          },
        ];
        let time = 1_000;
        for (const event of unavailable) {
          yield* h.emit("context_with_system");
          yield* h.emit("message_update", delta("text_delta", "partial"));
          h.at((time += 10_000));
          yield* h.emit("message_end", event);
          expect(h.rate()).toEqual({ approximate: false, value: 100 });
        }
        for (const stop of ["toolUse", "length"]) {
          yield* h.emit("context_with_system");
          h.at((time += 1_000));
          yield* h.emit("message_end", completion(200, stop));
        }
        expect(h.rate()).toEqual({ approximate: false, value: 166.7 });
      }),
  );

  it.effect("counts output and full call time while prompts or unavailable UI hide the row", () =>
    Effect.gen(function* () {
      const h = yield* workingHost;
      yield* h.emit("context_with_system");
      h.at(1_000);
      yield* h.emit("ui_prompt_start");
      yield* h.emit("message_update", delta("text_delta", "😀".repeat(40)));
      h.at(10_000);
      yield* h.emit("ui_prompt_end");
      expect(h.rate()).toEqual({ approximate: true, value: 2 });
      h.mode("rpc");
      h.rate();
      h.at(20_000);
      yield* h.emit("message_update", delta("thinking_delta", "你".repeat(80)));
      h.mode("tui");
      yield* h.emit("message_end", completion(400));
      expect(h.rate()).toEqual({ approximate: false, value: 20 });
    }),
  );

  it.effect("discards unfinished calls and measured totals on replacement and new runs", () =>
    Effect.gen(function* () {
      const h = yield* workingHost;
      yield* h.emit("context_with_system");
      h.at(1_000);
      yield* h.emit("message_end", completion(100));
      yield* h.emit("context_with_system");
      yield* h.emit("session_start");
      yield* h.emit("agent_start");
      h.at(3_000);
      yield* h.emit("message_end", completion(1_000));
      expect(h.rate()).toBeUndefined();
      yield* h.emit("context_with_system");
      h.at(4_000);
      yield* h.emit("message_end", completion(50));
      expect(h.rate()).toEqual({ approximate: false, value: 50 });
      yield* h.emit("agent_end");
      yield* h.emit("agent_start");
      expect(h.rate()).toBeUndefined();
    }),
  );
});
