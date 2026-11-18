import { afterAll, describe, expect, it } from "@effect/vitest";
import * as os from "node:os";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { yieldUntil } from "pi-cosmic-core/testing";
import { findOrUndefined } from "pi-cosmic-core/array";
import type { RpcCommand } from "../../src/backend/local-pi-protocol.ts";
import { TRANSCRIPT_REPLY_OVERSIZED } from "../../src/backend/model.ts";
import type { SubagentTranscriptEvent } from "../../src/run/transcript.ts";
import { nodeFs, nodePath } from "../support/node-builtins.ts";
import { oversizedLine, OVERSIZED_IMAGE_DATA } from "../support/oversized-line.ts";
import {
  completeLocalRun,
  fakeChildLayer,
  localServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";

const sessionDirectory = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-subagents-transcript-"));
afterAll(() => nodeFs.rmSync(sessionDirectory, { recursive: true, force: true }));
let nextSessionFile = 0;
const sessionFile = () => nodePath.join(sessionDirectory, `session-${nextSessionFile++}.jsonl`);
const appendEntries = (file: string, ...entries: ReadonlyArray<object>) =>
  nodeFs.appendFileSync(
    file,
    Arr.join(
      Arr.map(entries, (entry) => `${JSON.stringify(entry)}\n`),
      "",
    ),
  );

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

const entriesSince = (commands: ReadonlyArray<RpcCommand>) =>
  Arr.flatMap(commands, (command) => (command.type === "get_entries" ? [command.since] : []));

describe("a conversation too large for one reply", () => {
  const large = messageEntry("e3", "e2", "assistant", OVERSIZED_IMAGE_DATA);

  it.effect("rereads the session file and asks the child only past its new end", () => {
    const file = sessionFile();
    appendEntries(
      file,
      messageEntry("e1", null, "user", "task"),
      messageEntry("e2", "e1", "assistant", "on it"),
    );
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { sessionFile: file }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const child = fake.controls[0]!;
      child.sessionEntries.push(
        messageEntry("e1", null, "user", "task"),
        messageEntry("e2", "e1", "assistant", "on it"),
        large,
      );
      const answered = yield* Deferred.make<void>();
      child.gateNextSend("get_entries", answered);
      const events: SubagentTranscriptEvent[] = [];
      const scope = yield* Scope.make();
      const watching = yield* service
        .watchTranscript(run.id, (event) => events.push(event))
        .pipe(Scope.provide(scope), Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => child.sent("get_entries"));
      // Pi writes the entry to its file before the reply that carries it.
      appendEntries(file, large);
      yield* Deferred.succeed(answered, undefined);
      yield* Fiber.join(watching);

      expect(entriesSince(child.commands)).toEqual(["e2", "e3"]);
      expect(seen(events)).toEqual([
        { type: "snapshot", live: true, roles: ["user", "assistant", "assistant"] },
      ]);
      yield* Scope.close(scope, Exit.void);
      yield* completeLocalRun(service, child, run.id);
    });
  });

  it.effect("fails only the watch when the file holds nothing newer", () => {
    const file = sessionFile();
    appendEntries(
      file,
      messageEntry("e1", null, "user", "task"),
      messageEntry("e2", "e1", "assistant", "on it"),
    );
    const { fake, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { sessionFile: file }),
    );
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const child = fake.controls[0]!;
      child.sessionEntries.push(
        messageEntry("e1", null, "user", "task"),
        messageEntry("e2", "e1", "assistant", "on it"),
        large,
      );
      const events: SubagentTranscriptEvent[] = [];
      const failure = yield* service
        .watchTranscript(run.id, (event) => events.push(event))
        .pipe(Effect.scoped, Effect.flip);

      expect(failure).toMatchObject({ code: TRANSCRIPT_REPLY_OVERSIZED });
      expect(events).toEqual([]);
      expect(entriesSince(child.commands)).toEqual(["e2"]);
      expect((yield* runView(service, run.id)).state).toBe("running");
      yield* completeLocalRun(service, child, run.id);
    });
  });

  it.effect("ignores a reply that arrives after its watch ended", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const child = fake.controls[0]!;
      child.dropNextResponse("get_entries");
      const watching = yield* service
        .watchTranscript(run.id, () => {})
        .pipe(Effect.scoped, Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => child.sent("get_entries"));
      yield* Fiber.interrupt(watching);
      const late = (id: string) =>
        oversizedLine({
          type: "response",
          id,
          command: "get_entries",
          success: true,
          data: { entries: [large], leafId: "e3" },
        });
      const canceled = findOrUndefined(child.commands, (command) => command.type === "get_entries");
      child.offerOversizedLine(late(canceled?.id ?? "backend-rpc-missing"));
      child.offerOversizedLine(late("backend-rpc-unknown"));

      yield* completeLocalRun(service, child, run.id);
    });
  });
});
