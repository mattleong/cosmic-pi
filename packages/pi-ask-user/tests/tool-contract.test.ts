import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { captureRegistrations, issueMessageStyleProblems } from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import type { AsyncQuestionnaireSnapshot } from "../src/questionnaire/async-model.ts";
import { formatAskUserOutcome, formatAsyncSnapshot } from "../src/questionnaire/format.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest, AskUserAsyncControl } from "../src/questionnaire/schema.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { QuestionnaireContractSchema } from "../src/tools/contract-schema.ts";
import { asyncRequest, cancelled } from "./support/questionnaire.ts";

const envelope = { contract: "pi-ask-user/questionnaire", version: 1 };
const snapshot = (
  overrides: Partial<AsyncQuestionnaireSnapshot> = {},
): AsyncQuestionnaireSnapshot => ({
  requestId: "ask-1",
  deliveryId: "ask-1-answer",
  status: "pending",
  presentation: "open",
  independentWork: "Inspect existing code",
  blockedWork: "Choose the implementation",
  delivery: "pending",
  ...overrides,
});
const textOutcome: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "wording", kind: "text", text: "Keep this wording", note: "Do not paraphrase" }],
};
interface Callbacks {
  ask: Parameters<typeof registerAskUserTool>[1];
  start: Parameters<typeof registerAsyncAskUserTools>[1];
  control: Parameters<typeof registerAsyncAskUserTools>[2];
}
const registered = (callbacks: Partial<Callbacks> = {}) =>
  captureRegistrations((pi) => {
    registerAskUserTool(pi, callbacks.ask ?? (() => Promise.resolve(cancelled)));
    registerAsyncAskUserTools(
      pi,
      callbacks.start ?? (() => Promise.resolve(snapshot())),
      callbacks.control ?? (() => Promise.resolve({ requests: [] })),
    );
  }).tools;
const ctx = extensionContextFixture({ cwd: "/project" });
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(QuestionnaireContractSchema), {
  onExcessProperty: "error",
});
const execute = (
  tools: ReturnType<typeof registered>,
  name: string,
  input: AskUserRequest | AskUserAsyncControl = asyncRequest,
  signal?: AbortSignal,
) => tools.find((tool) => tool.name === name)!.execute("call", input, signal, undefined, ctx);
const call = (...args: Parameters<typeof execute>) => Effect.promise(() => execute(...args));
const declaredAccepts = (
  tool: ReturnType<typeof registered>[number],
  value: Schema.Json | undefined,
) =>
  Schema.is(
    SchemaRepresentation.fromJsonSchemaDocument(
      JsonSchema.fromSchemaDraft2020_12({ ...tool.outputSchema }),
    ),
  )(value);

const outcomes: AskUserOutcome[] = [
  cancelled,
  {
    outcome: "submitted",
    answers: [
      { key: "single", kind: "choices", values: ["safe"], labels: ["Safe"] },
      { key: "multiple", kind: "choices", values: ["a", "b"], labels: ["A", "B"], note: "Both" },
      { key: "custom", kind: "custom", text: "Another choice", note: "Because" },
      ...textOutcome.answers,
    ],
  },
];

describe("registered questionnaire structured results", () => {
  it.effect(
    "carries submitted answer variants and cancellation beside unchanged text and details",
    () =>
      Effect.gen(function* () {
        for (const outcome of outcomes) {
          const tools = registered({ ask: () => Promise.resolve(outcome) });
          const result = yield* call(tools, "ask_user");
          expect(result.isError).toBeUndefined();
          expect(result.details).toBe(outcome);
          expect(result.content).toEqual([{ type: "text", text: formatAskUserOutcome(outcome) }]);
          expect(decode(result.structuredContent)).toEqual({
            ...envelope,
            tool: "ask_user",
            ...outcome,
          });
          expect(declaredAccepts(tools[0]!, result.structuredContent)).toBe(true);
        }
      }),
  );

  it.effect(
    "preserves decision strings losslessly, including limits, controls and credential-like wording",
    () =>
      Effect.gen(function* () {
        const outcome: AskUserOutcome = {
          outcome: "submitted",
          answers: [
            {
              key: "token=literal",
              kind: "choices",
              values: ["api_key=literal\u001b[0m"],
              labels: ["Bearer literal"],
              note: "n".repeat(2000),
            },
            { key: "text", kind: "text", text: "\u001b[31mBearer literal\n".padEnd(4000, "x") },
            { key: "custom", kind: "custom", text: "  password=literal\nkeep whitespace  " },
          ],
        };
        const result = yield* call(registered({ ask: () => Promise.resolve(outcome) }), "ask_user");
        expect(decode(result.structuredContent)).toEqual({
          ...envelope,
          tool: "ask_user",
          ...outcome,
        });
        expect(result.details).toBe(outcome);
      }),
  );

  it.effect(
    "projects start and every control action without interpreting delivery as acknowledgement",
    () =>
      Effect.gen(function* () {
        const states: AsyncQuestionnaireSnapshot[] = [
          snapshot({ presentation: "queued" }),
          snapshot({ presentation: "hidden" }),
          snapshot({
            status: "submitted",
            presentation: "settled",
            delivery: "sent",
            outcome: textOutcome,
          }),
          snapshot({
            status: "submitted",
            presentation: "settled",
            delivery: "failed",
            outcome: textOutcome,
          }),
          snapshot({
            status: "cancelled",
            presentation: "settled",
            delivery: "waiter",
            outcome: cancelled,
          }),
          snapshot({ status: "failed", presentation: "settled", delivery: "none" }),
        ];
        for (const request of states) {
          const details = { requests: [request] };
          const tools = registered({
            start: () => Promise.resolve(request),
            control: () => Promise.resolve(details),
          });
          const started = yield* call(tools, "ask_user_async");
          expect(started.details).toBe(request);
          expect(started.content).toEqual([{ type: "text", text: formatAsyncSnapshot(request) }]);
          expect(decode(started.structuredContent)).toEqual({
            ...envelope,
            tool: "ask_user_async",
            request,
          });
          expect(declaredAccepts(tools[1]!, started.structuredContent)).toBe(true);
          for (const action of ["status", "await", "cancel"] as const) {
            const result = yield* call(tools, "ask_user_async_control", {
              action,
              requestId: request.requestId,
            });
            expect(result.isError).toBeUndefined();
            expect(result.details).toBe(details);
            expect(result.content).toEqual([{ type: "text", text: formatAsyncSnapshot(request) }]);
            expect(decode(result.structuredContent)).toEqual({
              ...envelope,
              tool: "ask_user_async_control",
              action,
              requestId: request.requestId,
              requests: [request],
            });
            expect(declaredAccepts(tools[2]!, result.structuredContent)).toBe(true);
          }
        }
        const result = yield* call(registered(), "ask_user_async_control", { action: "status" });
        expect(decode(result.structuredContent)).toEqual({
          ...envelope,
          tool: "ask_user_async_control",
          action: "status",
          requests: [],
        });
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.any(String) });
      }),
  );

  it.effect(
    "omits private fields and makes ID-free status metadata-only even if a callback includes answers",
    () =>
      Effect.gen(function* () {
        const outcome = {
          outcome: "submitted" as const,
          answers: [
            {
              key: "wording",
              kind: "text" as const,
              text: "The answer",
              note: "Context",
              draft: "private draft",
            },
          ],
          owner: "private owner",
        };
        const request = {
          ...snapshot({ status: "submitted", delivery: "sent", outcome }),
          questions: asyncRequest.questions,
          generation: "private generation",
          waiter: Symbol("private waiter"),
          opened: () => undefined,
        };
        const tools = registered({
          ask: () => Promise.resolve(outcome),
          start: () => Promise.resolve(request),
          control: () => Promise.resolve({ requests: [request] }),
        });
        const blocking = decode((yield* call(tools, "ask_user")).structuredContent);
        expect(blocking).toEqual({
          ...envelope,
          tool: "ask_user",
          outcome: "submitted",
          answers: [{ key: "wording", kind: "text", text: "The answer", note: "Context" }],
        });
        const started = decode((yield* call(tools, "ask_user_async")).structuredContent);
        expect(started).toMatchObject({
          request: { requestId: "ask-1", outcome: { answers: [{ text: "The answer" }] } },
        });
        for (const field of ["questions", "generation", "waiter", "opened"])
          expect(started).not.toHaveProperty(["request", field]);
        expect(started).not.toHaveProperty(["request", "outcome", "owner"]);
        expect(started).not.toHaveProperty(["request", "outcome", "answers", 0, "draft"]);
        const listed = decode(
          (yield* call(tools, "ask_user_async_control", { action: "status" })).structuredContent,
        );
        expect(listed).not.toHaveProperty("requestId");
        expect(listed).not.toHaveProperty(["requests", 0, "outcome"]);
        expect(listed).toMatchObject({ requests: [{ status: "submitted", delivery: "sent" }] });
      }),
  );

  it.effect(
    "returns detached, deeply frozen values without freezing the service or display details",
    () =>
      Effect.gen(function* () {
        const answer = {
          key: "choice",
          kind: "choices" as const,
          values: ["a"],
          labels: ["A"],
          note: "Original",
        };
        const outcome = { outcome: "submitted" as const, answers: [answer] };
        const request = { ...snapshot(), outcome };
        const requests = [request];
        const tools = registered({
          ask: () => Promise.resolve(outcome),
          start: () => Promise.resolve(request),
          control: () => Promise.resolve({ requests }),
        });
        const results = yield* Effect.all([
          call(tools, "ask_user"),
          call(tools, "ask_user_async"),
          call(tools, "ask_user_async_control", { action: "await", requestId: request.requestId }),
        ]);
        const before = results.map((result) => decode(result.structuredContent));
        const checkFrozen = <Value>(value: Value): void => {
          if (Predicate.isObject(value)) {
            expect(Object.isFrozen(value)).toBe(true);
            Object.values(value).forEach(checkFrozen);
          }
        };
        results.forEach((result) => checkFrozen(result.structuredContent));
        expect(Object.isFrozen(outcome)).toBe(false);
        expect(Object.isFrozen(answer.values)).toBe(false);
        answer.note = "Changed";
        answer.values.push("b");
        request.requestId = "changed";
        requests.length = 0;
        expect(results.map((result) => decode(result.structuredContent))).toEqual(before);
        expect(results[0]!.details).toBe(outcome);
        expect(results[1]!.details).toBe(request);
      }),
  );

  it.effect(
    "preserves receipts and details after encoding failure with no codec diagnostics or partial contract",
    () =>
      Effect.gen(function* () {
        const invalidOutcome: AskUserOutcome = {
          outcome: "submitted",
          answers: [{ key: "text", kind: "text", text: "private codec input".repeat(300) }],
        };
        const badId = snapshot({ requestId: "r".repeat(101) });
        const badDelivery = snapshot({ deliveryId: "d".repeat(121) });
        const badWork = snapshot({ independentWork: "w".repeat(501) });
        const tooMany = { requests: Array.from({ length: 17 }, () => snapshot()) };
        const cases = [
          {
            name: "ask_user",
            input: asyncRequest,
            details: invalidOutcome,
            text: formatAskUserOutcome(invalidOutcome),
            callbacks: { ask: () => Promise.resolve(invalidOutcome) },
          },
          ...[badId, badDelivery, badWork].map((request) => ({
            name: "ask_user_async",
            input: asyncRequest,
            details: request,
            text: formatAsyncSnapshot(request),
            callbacks: { start: () => Promise.resolve(request) },
          })),
          {
            name: "ask_user_async_control",
            input: { action: "status" as const },
            details: tooMany,
            text: tooMany.requests.map(formatAsyncSnapshot).join("\n\n"),
            callbacks: { control: () => Promise.resolve(tooMany) },
          },
        ];
        for (const entry of cases) {
          const result = yield* call(registered(entry.callbacks), entry.name, entry.input);
          expect(result.isError).toBe(true);
          expect(result).not.toHaveProperty("structuredContent");
          expect(result.details).toBe(entry.details);
          expect(result.content).toHaveLength(1);
          const part = result.content[0];
          const text = part?.type === "text" ? part.text : "";
          const newline = text.indexOf("\n");
          expect(issueMessageStyleProblems(text.slice(0, newline))).toEqual([]);
          expect(text.slice(newline + 1)).toBe(entry.text);
          expect(text.slice(0, newline)).not.toMatch(/Schema|Parse|private codec input/);
        }
      }),
  );

  it.effect("passes signals and service rejection through without fabricating cancellation", () =>
    Effect.gen(function* () {
      const failure = new Error("Owned service refused admission");
      const signal = yield* Effect.abortSignal;
      const seen: (AbortSignal | undefined)[] = [];
      const reject = (_input: AskUserRequest | AskUserAsyncControl, signal?: AbortSignal) => {
        seen.push(signal);
        return Promise.reject(failure);
      };
      const tools = registered({ ask: reject, start: reject, control: reject });
      for (const name of ["ask_user", "ask_user_async", "ask_user_async_control"])
        yield* Effect.promise(() =>
          expect(execute(tools, name, asyncRequest, signal)).rejects.toBe(failure),
        );
      expect(seen).toEqual([signal, signal, signal]);
    }),
  );
});
