import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { captureRegistrations, issueMessageStyleProblems } from "pi-code-previews/testing";
import { extensionContextFixture, toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import type { AsyncQuestionnaireSnapshot } from "../src/questionnaire/async-model.ts";
import { formatAskUserOutcome, formatAsyncSnapshot } from "../src/questionnaire/format.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest, AskUserAsyncControl } from "../src/questionnaire/schema.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { QuestionnaireContractSchema } from "../src/tools/contract-schema.ts";
import { asyncRequest, cancelled, defaultQuestion } from "./support/questionnaire.ts";

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

describe("registered questionnaire parameters", () => {
  it("declare only provider-portable schema keywords", () => {
    const tools = registered();
    expect(tools.length).toBe(3);
    for (const tool of tools) expect(toolSchemaPortabilityProblems(tool.parameters)).toEqual([]);
  });
});

const preparer = (name: string) => {
  const prepareArguments = registered().find((tool) => tool.name === name)?.prepareArguments;
  if (prepareArguments === undefined) throw new Error(`${name} has no argument preparation`);
  return prepareArguments;
};
const issueLines = (name: string, args: Schema.Json): ReadonlyArray<string> => {
  try {
    preparer(name)(args);
    return [];
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toMatch(/\[invalid_arguments\]/u);
    return message.split("\n").filter((line) => line.startsWith("- "));
  }
};
const textQuestion = { key: "wording", title: "Wording", prompt: "What wording?", mode: "text" };
const sixChoices = Array.from({ length: 6 }, (_, index) => ({
  value: `v${index}`,
  label: `Choice ${index + 1}`,
  description: "A concrete option.",
}));

describe("registered questionnaire arguments", () => {
  it("ignores empty choices on text questions and blank optional previews", () => {
    for (const choices of [[], null]) {
      expect(preparer("ask_user")({ questions: [{ ...textQuestion, choices }] })).toEqual({
        questions: [textQuestion],
      });
      expect(
        preparer("ask_user_async")({ ...asyncRequest, questions: [{ ...textQuestion, choices }] }),
      ).toEqual({ ...asyncRequest, questions: [textQuestion] });
    }
    const [first, second] = defaultQuestion.choices;
    expect(
      preparer("ask_user")({
        questions: [{ ...defaultQuestion, choices: [{ ...first, preview: " " }, second] }],
      }),
    ).toEqual({ questions: [defaultQuestion] });
    expect(preparer("ask_user_async_control")({ action: "status", requestId: null })).toEqual({
      action: "status",
    });
  });

  it("still rejects meaningful choices on a text question", () => {
    const issues = issueLines("ask_user", {
      questions: [{ ...textQuestion, choices: defaultQuestion.choices }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/questions\[0\].*"choices"/u);
  });

  it("reports only the issues of the shape a question's mode selects", () => {
    const issues = issueLines("ask_user", {
      questions: [
        textQuestion,
        { ...defaultQuestion, choices: [{ value: "a", label: "A" }] },
        { ...defaultQuestion, mode: "choice" },
      ],
    });
    expect(issues.length).toBeGreaterThan(0);
    const choiceShape = issues.filter((issue) => issue.includes("questions[1]"));
    expect(choiceShape.some((issue) => issue.includes("questions[1].choices[0].description"))).toBe(
      true,
    );
    expect(choiceShape.some((issue) => issue.includes("questions[1].choices "))).toBe(true);
    expect(choiceShape.some((issue) => /mode|anyOf|does not accept/u.test(issue))).toBe(false);
    const unknownMode = issues.filter((issue) => issue.includes("questions[2]"));
    expect(unknownMode).toHaveLength(1);
    expect(unknownMode[0]).toMatch(/questions\[2\]\.mode.*single.*multiple.*text/u);
    expect(issues.some((issue) => issue.includes("questions[0]"))).toBe(false);
  });

  it("accepts titles longer than a tab shows and up to six choices", () => {
    const question = {
      ...defaultQuestion,
      title: "Database migration strategy",
      choices: sixChoices,
    };
    expect(preparer("ask_user")({ questions: [question] })).toEqual({ questions: [question] });
    expect(
      issueLines("ask_user", {
        questions: [{ ...question, choices: [...sixChoices, { ...sixChoices[0], value: "v7" }] }],
      }),
    ).toHaveLength(1);
  });
});

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
});
