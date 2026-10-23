import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
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
  const line = Option.getOrUndefined(
    Arr.findFirst(Str.split(text, "\n"), Str.startsWith("WORKFLOW_RESULT ")),
  );
  expect(line, text).toBeDefined();
  return decodeOutput(Fn.pipe(line!, Str.slice("WORKFLOW_RESULT ".length)));
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
            return Match.value(key).pipe(
              Match.withReturnType<AskUserOutcome>(),
              Match.when("choice", () => submitted),
              Match.when("wording", () => ({
                outcome: "submitted",
                answers: [{ key, kind: "text", text: "Use the user's words", note: "Verbatim" }],
              })),
              Match.orElse(() => ({ outcome: "cancelled", answers: [] })),
            );
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
});
