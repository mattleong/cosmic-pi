// Public SDK host boundary: the real agent loop runs the local Pi child bridge; no inference.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  LOCAL_PI_RESULT_CONTRACT_FLAG,
  LocalPiResultContractDocument,
  type LocalPiContact,
} from "../src/backend/local-pi-protocol.ts";
import { canonicalResultJson, compileResultContract } from "../src/domain/result-contract.ts";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import {
  MAX_RESULT_REMINDERS,
  RESULT_REMINDER_MESSAGE_TYPE,
} from "../src/boundary/host-child-result.ts";
import type {
  LocalPiChildIpcChannel,
  LocalPiChildIpcHandlers,
} from "../src/boundary/local-pi-ipc.ts";
import { SUBAGENT_RESULT_TOOL_NAME } from "../src/run/tool-policy.ts";
import { step } from "./support/effect-test.ts";

const VERDICT = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["ok", "bad"] } },
  required: ["verdict"],
  additionalProperties: false,
} satisfies Schema.Json;

const encodeContractDocument = Schema.encodeEffect(
  Schema.fromJsonString(LocalPiResultContractDocument),
);

interface ChildSessionOptions {
  readonly schema?: Schema.Json | undefined;
  /** The parent's rejection message for a submission, or undefined to accept it. */
  readonly reject?: ((valueJson: string) => string | undefined) | undefined;
}

/** A real Pi session running the child bridge, with a parent IPC fake that answers results. */
const childSession = (options: ChildSessionOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "subagents-result-" });
    const fake = fauxProvider({ provider: "subagent-result-test", tokensPerSecond: 0 });
    const models = yield* step(() =>
      ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      }),
    );
    models.registerNativeProvider(fake.provider);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => models.unregisterProvider(fake.provider.id)),
    );

    const contacts: LocalPiContact[] = [];
    let listener: LocalPiChildIpcHandlers | undefined;
    const ipc: LocalPiChildIpcChannel = {
      sendContact: (contact) =>
        Effect.sync(() => {
          contacts.push(contact);
          if (contact.type !== "structured_result") return;
          const message = options.reject?.(contact.valueJson);
          listener?.onControl({
            channel: "pi-subagents",
            type: "structured_result_ack",
            requestId: contact.requestId,
            ok: message === undefined,
            ...(message !== undefined && { message }),
          });
        }),
      listen: (handlers) => {
        listener = handlers;
        return () => {
          if (listener === handlers) listener = undefined;
        };
      },
    };

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "subagent-child-result-test",
          factory: (pi) =>
            registerSubagentChildBridge(pi, {
              loadSettings: () => Promise.resolve(),
              openIpc: () => ipc,
            }),
        },
      ],
    });
    yield* step(() => loader.reload());
    if (options.schema !== undefined) {
      const contract = yield* compileResultContract(options.schema).pipe(Effect.orDie);
      const file = path.join(directory, "result-schema.json");
      const source = yield* encodeContractDocument({
        parameters: contract.parameters,
        strictSafe: contract.strictSafe,
      }).pipe(Effect.orDie);
      yield* fs.writeFileString(file, source).pipe(Effect.orDie);
      // Pi's CLI parser fills this runtime map from `--pi-subagents-result-schema <file>`.
      loader.getExtensions().runtime.flagValues.set(LOCAL_PI_RESULT_CONTRACT_FLAG, file);
    }
    const { session } = yield* Effect.acquireRelease(
      step(() =>
        createAgentSession({
          cwd: directory,
          agentDir: directory,
          model: fake.getModel(),
          modelRuntime: models,
          settingsManager: settings,
          sessionManager: SessionManager.inMemory(directory),
          resourceLoader: loader,
        }),
      ),
      ({ session }) =>
        step(() => session.abort()).pipe(
          Effect.andThen(
            step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
          ),
          Effect.ensuring(Effect.sync(() => session.dispose())),
        ),
    );
    yield* step(() => session.bindExtensions({ mode: "print" }));

    const run = (responses: ReadonlyArray<AssistantMessage>) =>
      Effect.gen(function* () {
        fake.setResponses([...responses]);
        yield* step(() => session.prompt("Return the verdict"));
        const messages = session.agent.state.messages;
        return {
          requests: fake.state.callCount,
          unused: fake.getPendingResponseCount(),
          submissions: contacts.flatMap((contact) =>
            contact.type === "structured_result" ? [contact.valueJson] : [],
          ),
          results: messages.flatMap((message) =>
            message.role === "toolResult" && message.toolName === SUBAGENT_RESULT_TOOL_NAME
              ? [
                  {
                    isError: message.isError,
                    text: message.content
                      .flatMap((part) => (part.type === "text" ? [part.text] : []))
                      .join("\n"),
                  },
                ]
              : [],
          ),
          reminders: messages.filter(
            (message) =>
              message.role === "custom" && message.customType === RESULT_REMINDER_MESSAGE_TYPE,
          ).length,
        };
      });
    return { session, run };
  });

const callResult = (args: Record<string, Schema.Json>) =>
  fauxAssistantMessage(fauxToolCall(SUBAGENT_RESULT_TOOL_NAME, args), { stopReason: "toolUse" });

const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer));

// Live time is intentional: the real agent loop schedules its own provider streaming.
describe("local Pi child result tool", () => {
  it.live("is absent, with no reminder, for a launch without a result contract", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession();
        expect(child.session.getActiveToolNames()).not.toContain(SUBAGENT_RESULT_TOOL_NAME);
        const outcome = yield* child.run([fauxAssistantMessage("Plain report.")]);
        expect(outcome).toMatchObject({ requests: 1, reminders: 0, submissions: [] });
      }),
    ),
  );

  it.live("lets Pi reject invalid arguments, then submits one valid result and ends the run", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession({ schema: VERDICT });
        expect(child.session.getActiveToolNames()).toContain(SUBAGENT_RESULT_TOOL_NAME);
        const outcome = yield* child.run([
          callResult({ verdict: "maybe" }),
          callResult({ verdict: "ok" }),
          fauxAssistantMessage("A request after acceptance must not happen."),
        ]);
        expect(outcome.submissions).toEqual([canonicalResultJson({ verdict: "ok" })]);
        expect(outcome.results.map((result) => result.isError)).toEqual([true, false]);
        expect(outcome).toMatchObject({ requests: 2, unused: 1, reminders: 0 });
      }),
    ),
  );

  it.live("returns the parent's rejection to the model, which can submit again", () =>
    live(
      Effect.gen(function* () {
        let rejections = 0;
        const child = yield* childSession({
          schema: VERDICT,
          reject: () => (rejections++ === 0 ? "verdict: parent sentinel issue" : undefined),
        });
        const outcome = yield* child.run([
          callResult({ verdict: "bad" }),
          callResult({ verdict: "ok" }),
        ]);
        expect(outcome.submissions).toHaveLength(2);
        expect(outcome.results[0]).toMatchObject({ isError: true });
        expect(outcome.results[0]?.text).toContain("parent sentinel issue");
        expect(outcome.results[1]).toMatchObject({ isError: false });
      }),
    ),
  );

  it.live("reminds a child that stops without a result, then submits in the same run", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession({ schema: VERDICT });
        const outcome = yield* child.run([
          fauxAssistantMessage("Done, the verdict is ok."),
          callResult({ verdict: "ok" }),
        ]);
        expect(outcome).toMatchObject({ requests: 2, reminders: 1 });
        expect(outcome.submissions).toEqual([canonicalResultJson({ verdict: "ok" })]);
      }),
    ),
  );

  it.live("enforces schema patterns in the child, which the root does not evaluate", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession({
          schema: {
            type: "object",
            properties: { code: { type: "string", pattern: "^[A-Z]+$" } },
            required: ["code"],
            additionalProperties: false,
          },
        });
        const outcome = yield* child.run([
          callResult({ code: "lower" }),
          callResult({ code: "UPPER" }),
        ]);
        expect(outcome.results.map((result) => result.isError)).toEqual([true, false]);
        expect(outcome.submissions).toEqual([canonicalResultJson({ code: "UPPER" })]);
      }),
    ),
  );

  it.live("gives every prompt, such as a resumed assignment, its own result and reminders", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession({ schema: VERDICT });
        const exhausted = yield* child.run(
          Array.from({ length: MAX_RESULT_REMINDERS + 1 }, (_, index) =>
            fauxAssistantMessage(`Prose answer ${index}.`),
          ),
        );
        expect(exhausted).toMatchObject({ reminders: MAX_RESULT_REMINDERS, submissions: [] });

        // The next prompt reminds again even though the last one used up its budget.
        const resumed = yield* child.run([
          fauxAssistantMessage("Still prose."),
          callResult({ verdict: "ok" }),
        ]);
        expect(resumed.reminders - exhausted.reminders).toBe(1);
        expect(resumed.submissions).toEqual([canonicalResultJson({ verdict: "ok" })]);

        // An accepted result belongs to its prompt; the next one must submit its own.
        const next = yield* child.run([
          fauxAssistantMessage("I already returned the verdict."),
          callResult({ verdict: "bad" }),
        ]);
        expect(next.reminders - resumed.reminders).toBe(1);
        expect(next.submissions.slice(resumed.submissions.length)).toEqual([
          canonicalResultJson({ verdict: "bad" }),
        ]);
      }),
    ),
  );

  it.live("stops reminding after its budget so the run can settle and fail", () =>
    live(
      Effect.gen(function* () {
        const child = yield* childSession({ schema: VERDICT });
        const outcome = yield* child.run(
          Array.from({ length: MAX_RESULT_REMINDERS + 2 }, (_, index) =>
            fauxAssistantMessage(`Prose answer ${index}.`),
          ),
        );
        expect(outcome).toMatchObject({
          requests: MAX_RESULT_REMINDERS + 1,
          unused: 1,
          reminders: MAX_RESULT_REMINDERS,
          submissions: [],
        });
      }),
    ),
  );
});
