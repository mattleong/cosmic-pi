// Real Pi agent loop and native QuickJS, with owned questionnaire service/host boundaries only.
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import { nativeCodemodeSession } from "./support/native-codemode-session.ts";
import { asyncRequest } from "./support/questionnaire.ts";

const acquireService = (...args: Parameters<typeof AskUserService.layer>) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(AskUserService.layer(...args), yield* Effect.scope);
    return Context.get(context, AskUserService);
  });
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const output = (text: string) => {
  const line = text.split("\n").find((line) => line.startsWith("WORKFLOW_RESULT "));
  expect(line, text).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;
const request = literal(asyncRequest);
const envelope = { contract: "pi-ask-user/questionnaire", version: 1 };
const submitted: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "choice", kind: "choices", values: ["a"], labels: ["A"], note: "Keep A" }],
};
const check = `function checked(value, tool) {
  if (value.contract !== 'pi-ask-user/questionnaire' || value.version !== 1 || value.tool !== tool)
    throw new Error('Unsupported questionnaire contract');
  return value;
}`;

// Live time is intentional for the real QuickJS worker. No model network or real UI prompts.
describe("native scripted questionnaire workflows", () => {
  it.live(
    "branches on submitted choices and text, and does not confuse cancellation with approval",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const service = yield* acquireService((input) =>
          Effect.sync(() => {
            const key = input.questions[0]!.key;
            seen.push(key);
            return key === "choice"
              ? submitted
              : key === "wording"
                ? {
                    outcome: "submitted",
                    answers: [
                      { key, kind: "text", text: "Use the user's words", note: "Verbatim" },
                    ],
                  }
                : { outcome: "cancelled", answers: [] };
          }),
        );
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
        ${check}
        const decision = checked(await tools.ask_user(${request}), 'ask_user');
        let wording;
        if (decision.outcome === 'submitted' && decision.answers[0].values.includes('a')) {
          const followup = checked(await tools.ask_user({questions:[{key:'wording',title:'Wording',prompt:'What wording?',mode:'text'}]}), 'ask_user');
          if (followup.outcome === 'submitted') wording = followup.answers[0].text;
        }
        const cancelled = checked(await tools.ask_user({questions:[{key:'cancel',title:'Cancel',prompt:'Another requirement?',mode:'text'}]}), 'ask_user');
        ${print("{decision,wording,approved:cancelled.outcome === 'submitted',cancelled}")}
      `);
        expect(result.isError, result.text).toBe(false);
        expect(output(result.text)).toEqual({
          decision: { ...envelope, tool: "ask_user", ...submitted },
          wording: "Use the user's words",
          approved: false,
          cancelled: { ...envelope, tool: "ask_user", outcome: "cancelled", answers: [] },
        });
        expect(seen).toEqual(["choice", "wording", "cancel"]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "chains an async receipt ID into await, metadata status and a completion-winning cancel",
    () =>
      Effect.gen(function* () {
        const service = yield* acquireService(
          (_input, presence) =>
            Effect.gen(function* () {
              if (presence) yield* Deferred.succeed(presence.opened, undefined);
              return submitted;
            }),
          () => Effect.void,
          "workflow",
        );
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
        ${check}
        const started = checked(await tools.ask_user_async(${request}), 'ask_user_async');
        text('REQUEST ' + started.request.requestId);
        const requestId = started.request.requestId;
        const awaited = checked(await tools.ask_user_async_control({action:'await',requestId}), 'ask_user_async_control');
        const listed = checked(await tools.ask_user_async_control({action:'status'}), 'ask_user_async_control');
        const cancelled = checked(await tools.ask_user_async_control({action:'cancel',requestId}), 'ask_user_async_control');
        ${print("{started,awaited,listed,cancelled}")}
      `);
        expect(result.isError, result.text).toBe(false);
        expect(output(result.text)).toMatchObject({
          started: {
            ...envelope,
            tool: "ask_user_async",
            request: { requestId: "workflow-1", status: "pending", presentation: "open" },
          },
          awaited: {
            ...envelope,
            tool: "ask_user_async_control",
            action: "await",
            requestId: "workflow-1",
            requests: [
              {
                requestId: "workflow-1",
                deliveryId: "workflow-1-answer",
                status: "submitted",
                delivery: "sent",
                outcome: submitted,
              },
            ],
          },
          listed: { action: "status", requests: [{ status: "submitted", delivery: "sent" }] },
          cancelled: { action: "cancel", requests: [{ outcome: submitted }] },
        });
        expect(output(result.text)).not.toHaveProperty(["started", "request", "outcome"]);
        expect(output(result.text)).not.toHaveProperty(["listed", "requests", 0, "outcome"]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "keeps host/control failures as rejected calls and failed openings as retained metadata",
    () =>
      Effect.gen(function* () {
        const service = yield* acquireService(
          () =>
            Effect.fail(
              new AskUserHostError({
                operation: "open",
                message: "Questionnaire host unavailable",
              }),
            ),
          undefined,
          "failed",
        );
        const h = yield* nativeCodemodeSession(service);
        const result = yield* h.run(`
        const results = await Promise.allSettled([
          tools.ask_user(${request}),
          tools.ask_user_async(${request}),
          tools.ask_user_async_control({action:'await'}),
          tools.ask_user_async_control({action:'status',requestId:'missing'}),
        ]);
        const listed = await tools.ask_user_async_control({action:'status'});
        ${print("{rejected:results.map(r=>r.status === 'rejected'),listed}")}
      `);
        expect(result.isError, result.text).toBe(false);
        expect(output(result.text)).toMatchObject({
          rejected: [true, true, true, true],
          listed: {
            ...envelope,
            tool: "ask_user_async_control",
            requests: [{ status: "failed", delivery: "none" }],
          },
        });
        expect(output(result.text)).not.toHaveProperty(["listed", "requests", 0, "outcome"]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "rejects encoding failure in scripts with the admitted receipt, not codec diagnostics",
    () =>
      Effect.gen(function* () {
        const service = yield* acquireService(() => Effect.succeed(submitted));
        const h = yield* nativeCodemodeSession({
          ...service,
          startAsync: () =>
            Effect.succeed({
              requestId: "receipt-7",
              deliveryId: "d".repeat(121),
              status: "pending",
              independentWork: "Inspect",
              blockedWork: "Choose",
              delivery: "pending",
            }),
        });
        const result = yield* h.run(`
        let rejected = false;
        try { await tools.ask_user_async(${request}); }
        catch (error) { rejected = true; text(error.message); }
        ${print("{rejected}")}
      `);
        expect(output(result.text)).toEqual({ rejected: true });
        expect(result.text).toContain("receipt-7");
        expect(result.text).not.toMatch(/Schema|ParseError/);
        const direct = yield* h.call("ask_user_async", asyncRequest);
        expect(direct.isError).toBe(true);
        expect(direct.message.details).toMatchObject({ requestId: "receipt-7", status: "pending" });
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "aborting a blocking script joins its presenter and releases the queue for the next call",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let blocking = true;
        const service = yield* acquireService(() =>
          blocking
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(released, undefined)),
              )
            : Effect.succeed(submitted),
        );
        const h = yield* nativeCodemodeSession(service);
        const pending = yield* h.run(`await tools.ask_user(${request});`).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.promise(() => h.session.abort());
        yield* Fiber.join(pending);
        yield* Deferred.await(released);
        blocking = false;
        const later = yield* h.run(
          `const answer = await tools.ask_user(${request}); ${print("answer")}`,
        );
        expect(output(later.text)).toEqual({ ...envelope, tool: "ask_user", ...submitted });
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "script await cancellation leaves the async presenter alive until explicit cancel",
    () =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const waitReleased = yield* Deferred.make<void>();
        const service = yield* acquireService(
          (_input, presence) =>
            Effect.gen(function* () {
              if (presence) yield* Deferred.succeed(presence.opened, undefined);
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Deferred.succeed(released, undefined))),
          undefined,
          "lifetime",
        );
        const h = yield* nativeCodemodeSession({
          ...service,
          controlAsync: (input) =>
            input.action === "await"
              ? Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(service.controlAsync(input)),
                  Effect.onInterrupt(() => Deferred.succeed(waitReleased, undefined)),
                )
              : service.controlAsync(input),
        });
        const started = yield* h.run(
          `const started = await tools.ask_user_async(${request}); ${print("started")}`,
        );
        expect(output(started.text)).toMatchObject({
          request: { requestId: "lifetime-1", status: "pending" },
        });
        const pending = yield* h
          .run(`await tools.ask_user_async_control({action:'await',requestId:'lifetime-1'});`)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* Effect.promise(() => h.session.abort());
        yield* Fiber.join(pending);
        yield* Deferred.await(waitReleased);
        expect(yield* Deferred.isDone(released)).toBe(false);
        const later = yield* h.run(`
        const status = await tools.ask_user_async_control({action:'status',requestId:'lifetime-1'});
        const cancelled = await tools.ask_user_async_control({action:'cancel',requestId:'lifetime-1'});
        ${print("{status,cancelled}")}
      `);
        expect(output(later.text)).toMatchObject({
          status: { requests: [{ status: "pending", delivery: "pending" }] },
          cancelled: {
            action: "cancel",
            requests: [
              {
                status: "cancelled",
                delivery: "waiter",
                outcome: { outcome: "cancelled", answers: [] },
              },
            ],
          },
        });
        yield* Deferred.await(released);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );
});
