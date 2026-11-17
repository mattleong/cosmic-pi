import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentTranscriptEvent } from "../../src/run/transcript.ts";
import { oversizedLine, OVERSIZED_IMAGE_DATA } from "../support/oversized-line.ts";
import {
  completeLocalRun,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const messageEntry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message:
    role === "user"
      ? { role, content: text, timestamp: 0 }
      : { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 },
});

const seen = (events: ReadonlyArray<SubagentTranscriptEvent>) =>
  Arr.map(events, (event) =>
    event.type === "snapshot"
      ? { type: event.type, live: event.live, roles: Arr.map(event.messages, ({ role }) => role) }
      : event,
  );

describe("watching a run's conversation", () => {
  it.effect("shows a live run its entries, then each event in order, until the watch ends", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const child = fake.controls[0]!;
      child.sessionEntries.push(
        messageEntry("e1", null, "user", "task"),
        messageEntry("e2", "e1", "assistant", "on it"),
      );
      const events: SubagentTranscriptEvent[] = [];
      const scope = yield* Scope.make();
      // An event the child emitted before it answered is already in its entries.
      child.beforeNextResponse("get_entries", {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta" },
      });
      yield* service
        .watchTranscript(run.id, (event) => events.push(event))
        .pipe(Scope.provide(scope));
      const started = {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      };
      child.offer(started);
      child.offer({ type: "turn_end" });
      yield* yieldUntil(() => events.length === 2);
      expect(seen(events)).toEqual([
        { type: "snapshot", live: true, roles: ["user", "assistant"] },
        { type: "event", value: started },
      ]);

      yield* Scope.close(scope, Exit.void);
      child.offer({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: { content: [] },
        isError: false,
      });
      yield* completeLocalRun(service, child, run.id);
      expect(events).toHaveLength(2);
    });
  });

  it.effect("shows a finished run what its session file holds, without a live process", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* completeLocalRun(service, fake.controls[0]!, run.id);
      const events: SubagentTranscriptEvent[] = [];
      yield* service.watchTranscript(run.id, (event) => events.push(event)).pipe(Effect.scoped);
      expect(seen(events)).toEqual([{ type: "snapshot", live: false, roles: [] }]);
      expect(fake.controls[0]!.sent("get_entries")).toBe(false);
    });
  });

  it.effect("reports an event too large to carry as a gap", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const child = fake.controls[0]!;
      const events: SubagentTranscriptEvent[] = [];
      const scope = yield* Scope.make();
      yield* service
        .watchTranscript(run.id, (event) => events.push(event))
        .pipe(Scope.provide(scope));
      child.offerOversizedLine(
        oversizedLine({
          type: "tool_execution_update",
          toolCallId: "t1",
          partialResult: { content: [{ type: "image", data: OVERSIZED_IMAGE_DATA }] },
        }),
      );
      yield* yieldUntil(() => events.length === 2);
      expect(events[1]).toEqual({ type: "gap" });
      yield* Scope.close(scope, Exit.void);
      yield* completeLocalRun(service, child, run.id);
    });
  });
});
