import { createEventBus } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { deferredPromise, yieldUntil } from "pi-cosmic-core/testing";
import { expect } from "vitest";
import { askInSession } from "../src/boundary/host-askers.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import {
  acquireService,
  asyncRequest,
  forkNow,
  keyedRequest,
  offerPane,
  submitted,
} from "./support/questionnaire.ts";

const paneAsk = (key: string) => ({ ...keyedRequest(key), askedBy: "agent" });

it.effect(
  "a pane loss hands two simultaneous asks back to the caller in order, ahead of later local asks",
  () =>
    Effect.gen(function* () {
      const bus = createEventBus();
      const entered = deferredPromise();
      const lost = deferredPromise<undefined>();
      const headAnswer = yield* Deferred.make<void>();
      const shown: string[] = [];
      const screens: string[] = [];
      offerPane(bus, (request, _signal, reportShown) => {
        const key = request.questions[0]!.key;
        screens.push(`pane:${key}`);
        if (key === "first") reportShown();
        entered.resolve();
        return lost.promise;
      });
      const service = yield* acquireService((request, presence) =>
        Effect.gen(function* () {
          const key = request.questions[0]!.key;
          screens.push(`root:${key}`);
          if (presence) yield* Deferred.succeed(presence.opened, undefined);
          if (key === "head") yield* Deferred.await(headAnswer);
          return submitted({ key, kind: "text", text: key });
        }),
      );
      const ask = (key: string) =>
        askInSession(bus, "root", paneAsk(key), () => {
          shown.push(key);
        }).pipe(Effect.provideService(AskUserService, service));
      yield* service.startAsync({ ...asyncRequest, ...keyedRequest("head") });
      const first = yield* forkNow(ask("first"));
      const second = yield* forkNow(ask("second"));
      const local = yield* forkNow(service.ask(keyedRequest("third")));
      // Async askedBy remains local, including when the same agent has a pane.
      const tail = yield* service.startAsync({ ...asyncRequest, ...paneAsk("tail") });
      const beforeHeadAnswer = [...screens];
      yield* Deferred.succeed(headAnswer, undefined);
      yield* Effect.promise(() => entered.promise);
      lost.resolve(undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ answers: [{ key: "first" }] });
      expect(yield* Fiber.join(second)).toMatchObject({ answers: [{ key: "second" }] });
      yield* Fiber.join(local);
      yield* service.controlAsync({ action: "await", requestId: tail.requestId });
      expect(tail.presentation).toBe("queued");
      expect(beforeHeadAnswer).toEqual(["root:head"]);
      expect(screens).toEqual([
        "root:head",
        "pane:first",
        "root:first",
        "pane:second",
        "root:second",
        "root:third",
        "root:tail",
      ]);
      expect(shown).toEqual(["first", "second"]);
    }),
);

it.effect(
  "cancelling a queued pane never shows it; cancelling the active pane joins withdrawal before advancing",
  () =>
    Effect.gen(function* () {
      const bus = createEventBus();
      const entered = deferredPromise<AbortSignal>();
      const withdrawn = deferredPromise<undefined>();
      const screens: string[] = [];
      offerPane(bus, (request, signal) => {
        screens.push(`pane:${request.questions[0]!.key}`);
        entered.resolve(signal);
        return withdrawn.promise;
      });
      const service = yield* acquireService((request, presence) =>
        Effect.gen(function* () {
          screens.push(`root:${request.questions[0]!.key}`);
          if (presence) yield* Deferred.succeed(presence.opened, undefined);
          return submitted();
        }),
      );
      const ask = (key: string) =>
        askInSession(bus, "root", paneAsk(key)).pipe(
          Effect.provideService(AskUserService, service),
        );
      const active = yield* forkNow(ask("active"));
      const signal = yield* Effect.promise(() => entered.promise);
      const queued = yield* forkNow(ask("cancelled"));
      yield* Fiber.interrupt(queued);
      const aborting = yield* forkNow(Fiber.interrupt(active));
      yield* yieldUntil(() => signal.aborted);
      const next = yield* service.startAsync({ ...asyncRequest, ...keyedRequest("next") });
      yield* TestClock.adjust(0);
      const duringWithdrawal = [...screens];
      withdrawn.resolve(undefined);
      yield* Fiber.join(aborting);
      yield* service.controlAsync({ action: "await", requestId: next.requestId });
      expect(next.presentation).toBe("queued");
      expect(duringWithdrawal).toEqual(["pane:active"]);
      expect(screens).toEqual(["pane:active", "root:next"]);
    }),
);
