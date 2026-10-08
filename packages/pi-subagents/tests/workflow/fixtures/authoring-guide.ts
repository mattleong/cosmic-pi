import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { SubagentBackendRegistry } from "../../../src/backend/service.ts";
import {
  runWorkflowSandbox,
  type WorkflowHostFailure,
  type WorkflowSandboxHost,
} from "../../../src/boundary/codemode-sandbox.ts";
import { makeWorkflowHost } from "../../../src/boundary/host-workflow.ts";
import { workflowAuthoringGuidePath } from "../../../src/boundary/workflow-authoring-guide.ts";
import { decodeJsonRecord, type JsonRecord } from "../../../src/domain/json-schema.ts";
import {
  compileResultContract,
  decodeResultValue,
  resultValueSchema,
} from "../../../src/domain/result-contract.ts";
import { SubagentProfileService } from "../../../src/profiles/service.ts";
import type { WorkflowHost } from "../../../src/workflow/agent.ts";
import { requireStartArgs } from "../../../src/workflow/args.ts";
import {
  decodeWorkflowAgentOptions,
  type WorkflowAgentOptions,
} from "../../../src/workflow/options.ts";
import { parseWorkflowScript } from "../../../src/workflow/script.ts";
import { extensionApiFixture } from "../../fixtures/pi-host.ts";
import { nodeFsPromises } from "../../support/node-builtins.ts";
import {
  context,
  profileServiceFor,
  testBackendRegistry,
} from "../../tools/fixtures/tool-harness.ts";

/** A `js` block in the guide; a `js fragment` block assumes definitions from the blocks around it. */
interface GuideExample {
  /** The line its fence opens on, which failures name. */
  readonly line: number;
  readonly fragment: boolean;
  readonly code: string;
}

export const readGuide = Effect.promise(() =>
  nodeFsPromises.readFile(workflowAuthoringGuidePath(), "utf8"),
);

const EXAMPLE_FENCE = /^```js( fragment)?\n([\s\S]*?)^```$/gmu;
const FRAGMENT_META = 'export const meta = { name: "guide-fragment", description: "A fragment" };';

export const guideExamples = (markdown: string): ReadonlyArray<GuideExample> =>
  [...markdown.matchAll(EXAMPLE_FENCE)].map((match) => ({
    line: markdown.slice(0, match.index).split("\n").length,
    fragment: match[1] !== undefined,
    code: match[2] ?? "",
  }));

export const scriptOf = (example: GuideExample): string =>
  example.fragment ? `${FRAGMENT_META}\n${example.code}` : example.code;

/** How a stubbed agent answers: booleans it returns, and how many items its arrays hold. */
interface StubAnswers {
  readonly name: string;
  readonly flag: boolean;
  readonly items: number;
}

export const ANSWERS: ReadonlyArray<StubAnswers> = [
  { name: "false, one item", flag: false, items: 1 },
  { name: "true, one item", flag: true, items: 1 },
  { name: "no items", flag: false, items: 0 },
];

const decodeTypes = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
const decodeChoices = Schema.decodeUnknownOption(Schema.Array(Schema.Json));
const decodeCount = Schema.decodeUnknownOption(Schema.Finite);

const schemaType = (node: JsonRecord): string | undefined => {
  const declared = Option.getOrUndefined(decodeTypes(node.type));
  const type = Array.isArray(declared)
    ? declared.find((entry) => entry !== "null")
    : (declared ?? undefined);
  return type ?? (node.properties === undefined ? undefined : "object");
};

const sampleObject = (node: JsonRecord, answers: StubAnswers): Schema.Json => {
  const properties = Option.getOrElse(decodeJsonRecord(node.properties), () => ({}));
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [name, sampleValue(schema, answers)]),
  );
};

const sampleOfType = (node: JsonRecord, answers: StubAnswers): Schema.Json => {
  switch (schemaType(node)) {
    case "object":
      return sampleObject(node, answers);
    case "array": {
      const length = Math.max(
        answers.items,
        Option.getOrElse(decodeCount(node.minItems), () => 0),
      );
      return Array.from({ length }, () => sampleValue(node.items ?? {}, answers));
    }
    case "string":
      return "sample";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return answers.flag;
    default:
      return null;
  }
};

/** A value the JSON Schema accepts, for the subset scripts write: what a stubbed agent returns. */
function sampleValue(schema: Schema.Json, answers: StubAnswers): Schema.Json {
  const node = Option.getOrUndefined(decodeJsonRecord(schema));
  if (node === undefined) return null;
  if (node.const !== undefined) return node.const;
  const [first] = Option.getOrElse(decodeChoices(node.enum), () => []);
  if (first !== undefined) return first;
  const [branch] = Option.getOrElse(decodeChoices(node.anyOf ?? node.oneOf), () => []);
  return branch === undefined ? sampleOfType(node, answers) : sampleValue(branch, answers);
}

const invalid = (message: string): WorkflowHostFailure => ({ _tag: "InvalidAgentCall", message });

/** The host's own call checks, over the built-in profiles. */
const workflowHost = makeWorkflowHost(extensionApiFixture({}), context, {
  cwd: "/project",
  projectTrusted: true,
}).pipe(
  Effect.provideService(SubagentProfileService, profileServiceFor(undefined)),
  Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
);

const decodeCall = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.String, Schema.Json, Schema.optionalKey(Schema.String)]),
);

/**
 * Answers one agent() call after the real option, schema and claim checks: text without a schema,
 * else a value the compiled schema accepts.
 */
const answer = (host: WorkflowHost, call: Schema.Json, answers: StubAnswers) =>
  Effect.gen(function* () {
    const [prompt, raw] = yield* decodeCall(call).pipe(
      Effect.mapError(() => invalid("agent() arguments don't decode.")),
    );
    const options = yield* decodeWorkflowAgentOptions(raw).pipe(
      Effect.mapError((error) => invalid(error.message)),
    );
    yield* host.checkAgent(options).pipe(Effect.mapError((error) => invalid(error.message)));
    if (options.schema === undefined) return `A report for: ${prompt.slice(0, 80)}`;
    const contract = yield* compileResultContract(options.schema).pipe(
      Effect.mapError((error) => invalid(`Invalid agent() schema: ${error.message}`)),
    );
    return yield* decodeResultValue(
      contract,
      sampleValue(resultValueSchema(contract), answers),
    ).pipe(Effect.mapError((error) => invalid(`The stub's answer doesn't fit: ${error.message}`)));
  });

/** Far above any example, so a loop that never ends fails instead of hanging the test. */
const CALL_LIMIT = 500;

const decodeWarning = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("log"),
    level: Schema.Literal("warning"),
    message: Schema.String,
  }),
);

/** Runs a complete script in the sandbox with stubbed agents; returns what went wrong, if anything. */
export const runProblems = (name: string, source: string, answers: StubAnswers) =>
  Effect.gen(function* () {
    const at = `${name} (${answers.name})`;
    const script = yield* parseWorkflowScript(source);
    const checks = yield* workflowHost;
    const calls = yield* Ref.make(0);
    const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
    const host: WorkflowSandboxHost<never> = {
      agent: (call) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count > CALL_LIMIT
              ? Effect.fail(invalid(`More than ${CALL_LIMIT} agent() calls.`))
              : answer(checks, call, answers),
          ),
          Effect.map((result) => ({ result, outputTokens: 1 })),
        ),
      event: (event) =>
        Option.match(decodeWarning(event), {
          onNone: () => Effect.void,
          onSome: ({ message }) => Ref.update(warnings, (all) => [...all, message]),
        }),
      load: () => Effect.fail(invalid("The examples don't run saved workflows.")),
    };
    const args = script.meta.args === undefined ? null : sampleValue(script.meta.args, answers);
    yield* requireStartArgs(script.args, script.meta.name, args);
    const outcome = yield* Effect.scoped(
      runWorkflowSandbox(script.body, args, host, Effect.never, undefined),
    );
    if (outcome._tag === "Failed") return [`${at}: ${outcome.failure.message}`];
    const started = yield* Ref.get(calls);
    return [
      ...(yield* Ref.get(warnings)).map((warning) => `${at}: ${warning}`),
      ...(started === 0 ? [`${at}: started no agent`] : []),
    ];
  }).pipe(Effect.catch((error) => Effect.succeed([`${name}: ${error.message}`])));

export interface GuideCall {
  readonly prompt: string;
  readonly options: WorkflowAgentOptions;
}

/** Executes real recipe code with checked calls and schema-settled replies, never real agents. */
export const runRecipe = (
  source: string,
  args: Schema.Json,
  reply: (call: GuideCall) => Effect.Effect<Schema.Json, WorkflowHostFailure>,
  options: { readonly budget?: number; readonly outputTokens?: number } = {},
) =>
  Effect.gen(function* () {
    const script = yield* parseWorkflowScript(source);
    yield* requireStartArgs(script.args, script.meta.name, args);
    const checks = yield* workflowHost;
    const calls = yield* Ref.make<ReadonlyArray<GuideCall>>([]);
    const warnings = yield* Ref.make<ReadonlyArray<string>>([]);
    const host: WorkflowSandboxHost<never> = {
      agent: (rawCall) =>
        Effect.gen(function* () {
          const [prompt, raw] = yield* decodeCall(rawCall).pipe(
            Effect.mapError(() => invalid("agent() arguments don't decode.")),
          );
          const decoded = yield* decodeWorkflowAgentOptions(raw).pipe(
            Effect.mapError((error) => invalid(error.message)),
          );
          yield* checks
            .checkAgent(decoded)
            .pipe(Effect.mapError((error) => invalid(error.message)));
          const call = { prompt, options: decoded };
          const started = yield* Ref.updateAndGet(calls, (all) => [...all, call]);
          if (started.length > CALL_LIMIT)
            return yield* Effect.fail(invalid("Recipe did not terminate."));
          const value = yield* reply(call);
          const contract =
            decoded.schema === undefined
              ? undefined
              : yield* compileResultContract(decoded.schema).pipe(
                  Effect.mapError((error) => invalid(error.message)),
                );
          // A missing/invalid structured report settles as a failed agent, not as evidence.
          const result =
            value === null || contract === undefined
              ? value
              : yield* decodeResultValue(contract, value).pipe(Effect.orElseSucceed(() => null));
          return { result, outputTokens: options.outputTokens ?? 1 };
        }),
      event: (event) =>
        Option.match(decodeWarning(event), {
          onNone: () => Effect.void,
          onSome: ({ message }) => Ref.update(warnings, (all) => [...all, message]),
        }),
      load: () => Effect.fail(invalid("The recipes don't load saved workflows.")),
    };
    const outcome = yield* Effect.scoped(
      runWorkflowSandbox(script.body, args, host, Effect.never, options.budget),
    );
    if (outcome._tag === "Failed") return yield* Effect.fail(invalid(outcome.failure.message));
    return {
      value: outcome.value,
      calls: yield* Ref.get(calls),
      warnings: yield* Ref.get(warnings),
    };
  });

/** Locate complete recipes by their declared name, rather than their prose or line number. */
export const recipe = (name: string) =>
  Effect.gen(function* () {
    for (const example of guideExamples(yield* readGuide)) {
      if (example.fragment) continue;
      const parsed = yield* parseWorkflowScript(example.code);
      if (parsed.meta.name === name) return example.code;
    }
    return yield* Effect.fail(invalid(`Missing guide recipe: ${name}`));
  });

/** A fragment's section identifies it; its executable code remains the tested artifact. */
export const fragment = (section: string) =>
  Effect.gen(function* () {
    const markdown = yield* readGuide;
    const start = markdown.indexOf(section);
    const [example] = guideExamples(markdown.slice(start));
    if (start < 0 || !example?.fragment)
      return yield* Effect.fail(invalid(`Missing guide fragment: ${section}`));
    return scriptOf(example);
  });
