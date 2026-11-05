import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  extensionContextFixture,
  recordingExtensionHost,
  type DefaultedEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import cosmicUi from "../index.ts";
import { assistantMessage, eventBus, execOk, type AssistantMessage } from "./support/host.ts";

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
  const emit = (name: DefaultedEventName) => Effect.promise(() => host.emit(name, ctx));
  const emitEvent = (event: ExtensionEvent) =>
    Effect.promise(() => host.emit(event.type, ctx, event));
  yield* emit("session_start");
  yield* Effect.addFinalizer(() => emit("session_shutdown"));
  yield* emit("agent_start");
  return {
    emit,
    emitEvent,
    at: (milliseconds: number) => {
      time = milliseconds;
    },
    mode: (next: "tui" | "rpc") => {
      mode = next;
    },
    rate: () => {
      tick?.();
      const value =
        message === undefined
          ? undefined
          : Option.getOrUndefined(Fn.pipe(message, Str.match(/(~?)([\d.]+) tokens\/s/u)));
      return value ? { approximate: value[1] === "~", value: Number(value[2]) } : undefined;
    },
  };
});

type Usage = AssistantMessage["usage"];
type StopReason = AssistantMessage["stopReason"];

const usageWith = (output: number): Usage => ({
  input: 50_000,
  output,
  reasoning: 100,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 50_000 + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const messageEnd = (
  message: ExtensionEventNamed<"message_end">["message"],
): ExtensionEventNamed<"message_end"> => ({ type: "message_end", message });
const completion = (output: number, stopReason: StopReason = "stop") =>
  messageEnd(assistantMessage(usageWith(output), stopReason));
const delta = (
  type: "text_delta" | "thinking_delta" | "toolcall_delta",
  text: string,
): ExtensionEventNamed<"message_update"> => ({
  type: "message_update",
  message: assistantMessage(),
  assistantMessageEvent: { type, contentIndex: 0, delta: text, partial: assistantMessage() },
});
const textStart = (): ExtensionEventNamed<"message_update"> => ({
  type: "message_update",
  message: assistantMessage(),
  assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistantMessage() },
});

describe("working throughput through registered Pi events", () => {
  it.effect("estimates while streaming, then reports measured output only during later calls", () =>
    Effect.gen(function* () {
      const h = yield* workingHost;
      yield* h.emit("context_with_system");
      h.at(10_000);
      yield* h.emitEvent({ type: "message_start", message: assistantMessage() });
      for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const)
        yield* h.emitEvent(delta(type, Fn.pipe("a", Str.repeat(40))));
      yield* h.emitEvent(textStart());
      expect(h.rate()).toEqual({ approximate: true, value: 3 });
      yield* h.emitEvent(completion(500));
      // No tokens flow between calls, so the row shows no rate while tools run.
      expect(h.rate()).toBeUndefined();
      h.at(50_000);
      yield* h.emitEvent({
        type: "tool_execution_start",
        toolCallId: "call",
        toolName: "read",
        args: {},
      });
      yield* h.emitEvent(
        messageEnd({
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 0,
          usage: usageWith(90_000),
        }),
      );
      expect(h.rate()).toBeUndefined();
      yield* h.emit("context_with_system");
      expect(h.rate()).toEqual({ approximate: false, value: 50 });
    }),
  );
});
