import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { extensionApiFixture, piKeybindingsFixture, yieldUntil } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { beforeAll } from "vitest";
import { openSubagentSessionView } from "../src/boundary/host-session-view.ts";
import { invalidRequest } from "../src/run/errors.ts";
import type { SubagentProjection, SubagentRunView } from "../src/run/model.ts";
import { SubagentService } from "../src/run/service.ts";
import type { SubagentTranscriptListener } from "../src/run/transcript.ts";
import { view as runView } from "./fixtures/run-view.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";

beforeAll(() => initTheme("dark", false));

const ESC = "\u001b";
const KEYS = new Map([["app.interrupt", ESC]]);
const userMessage = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });

const fixture = (initial: Partial<SubagentRunView>) =>
  Effect.gen(function* () {
    let projection: SubagentProjection = {
      revision: 1,
      runs: [runView({ id: "run", ...initial })],
    };
    const subscribers = new Set<() => void>();
    const watches: Array<{ readonly listener: SubagentTranscriptListener; closed: boolean }> = [];
    const calls: string[] = [];
    let sendFailure: { readonly message: string; readonly before: () => void } | undefined;
    const service = subagentServiceDouble({
      watchTranscript: (_id, listener) =>
        Effect.gen(function* () {
          const watch = { listener, closed: false };
          watches.push(watch);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              watch.closed = true;
            }),
          );
        }),
      send: (id, message) => {
        calls.push(`send:${message}`);
        if (sendFailure === undefined)
          return Effect.succeed({
            messageId: "m",
            to: id,
            name: id,
            disposition: "guided" as const,
          });
        sendFailure.before();
        return Effect.fail(invalidRequest("agent_unavailable", sendFailure.message));
      },
      resume: (_id, message) => {
        calls.push(`resume:${message ?? ""}`);
        return Effect.succeed(runView({ id: "run" }));
      },
      interrupt: () => {
        calls.push("interrupt");
        return Effect.succeed(runView({ id: "run", state: "paused" }));
      },
    });
    const keybindings: KeybindingsManager = piKeybindingsFixture({
      matches: (data, id) => KEYS.get(id) === data,
    });
    const surface = fakeCustomSurfaceHost({ columns: 80, rows: 24, keybindings });
    const opened = yield* openSubagentSessionView({
      ctx: surface.ctx,
      events: extensionApiFixture({}).events,
      runId: "run",
      projection: () => projection,
      subscribeProjection: (listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      isCurrent: () => true,
      messageRenderer: () => undefined,
      childToolRenderers: () => undefined,
    }).pipe(Effect.provideService(SubagentService, service), Effect.forkScoped);
    yield* yieldUntil(() => surface.pendingMounts === 1);
    surface.mount();
    yield* yieldUntil(() => watches.length === 1);
    const screen = () => surface.overlays.at(-1);
    return {
      opened,
      watches,
      calls,
      subscribers,
      text: () => stripAnsi(Arr.join(screen()?.render(80) ?? [], "\n")),
      type: (text: string) => {
        for (const key of text) screen()?.handleInput?.(key);
      },
      publish: (run: Partial<SubagentRunView>) => {
        projection = {
          revision: projection.revision + 1,
          runs: [runView({ id: "run", ...run })],
        };
        for (const listener of subscribers) listener();
      },
      /** Refuses sends from now on, after running `before`, such as the run finishing first. */
      failSends: (message: string, before: () => void = () => undefined) => {
        sendFailure = { message, before };
      },
    };
  });

describe("a subagent's session view", () => {
  it.effect("watches again when the run gets a new process, and only the new watch draws", () =>
    Effect.gen(function* () {
      const h = yield* fixture({ state: "completed", sessionFile: "/tmp/s.jsonl" });
      h.watches[0]!.listener({
        type: "snapshot",
        messages: [userMessage("first task")],
        live: false,
      });
      expect(h.text()).toContain("first task");

      h.publish({ state: "running", pid: 7 });
      yield* yieldUntil(() => h.watches.length === 2);
      expect(h.watches[0]!.closed).toBe(true);
      h.watches[0]!.listener({ type: "snapshot", messages: [userMessage("stale")], live: false });
      h.watches[1]!.listener({ type: "snapshot", messages: [userMessage("resumed")], live: true });
      expect(h.text()).toContain("resumed");
      expect(h.text()).not.toContain("stale");

      // The same process needs no new watch, and a gap asks for one.
      h.publish({ state: "running", pid: 7, progress: "reading" });
      h.watches[1]!.listener({ type: "gap" });
      yield* yieldUntil(() => h.watches.length === 3);
    }),
  );

  it.effect("sends by the run's state, and resumes a run that finished as the message left", () =>
    Effect.gen(function* () {
      const h = yield* fixture({ state: "running", pid: 7 });
      h.type("look at auth\r");
      yield* yieldUntil(() => h.calls.length === 1);

      // The run finishes between the view reading its state and the send reaching it.
      h.failSends("Agent run finished; resume it.", () =>
        h.publish({ state: "completed", sessionFile: "/tmp/s.jsonl" }),
      );
      h.type("and the tests\r");
      yield* yieldUntil(() => h.calls.length === 3);
      h.type("one more\r");
      yield* yieldUntil(() => h.calls.length === 4);
      expect(h.calls).toEqual([
        "send:look at auth",
        "send:and the tests",
        "resume:and the tests",
        "resume:one more",
      ]);
    }),
  );

  it.effect("says why a message wasn't delivered and gives the text back", () =>
    Effect.gen(function* () {
      const h = yield* fixture({ state: "running", pid: 7 });
      h.failSends("Agent run is stopping.");
      h.type("too late\r");
      yield* yieldUntil(() => Fn.pipe(h.text(), Str.includes("Agent run is stopping.")));
      expect(h.text()).toContain("too late");
      expect(h.text()).not.toContain("Steering:");
    }),
  );

  it.effect("interrupts a working run in place, and leaving ends the watch", () =>
    Effect.gen(function* () {
      const h = yield* fixture({ state: "running", pid: 7 });
      h.type(ESC);
      yield* yieldUntil(() => h.calls.length === 1);
      expect(h.calls).toEqual(["interrupt"]);
      h.publish({ state: "paused", pid: 7 });
      h.type(ESC);
      yield* Fiber.join(h.opened);
      expect(h.watches.at(-1)!.closed).toBe(true);
      expect(h.subscribers.size).toBe(0);
    }),
  );
});
