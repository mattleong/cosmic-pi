/** Standalone SDK host boundary. Owns one evaluation session and its explicit shutdown. */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { loadCodePreviewSettings } from "pi-code-previews";
import { registerCodeModeApplication } from "../src/application.ts";
import { candidateSelectionGuidelines } from "./candidate.ts";
import { outputGuidelines } from "./output-candidate.ts";
import { evaluationError, type EvaluationError } from "./errors.ts";
import { fixtureDefinitions, freshDispatchMetrics } from "./fixture-tools.ts";
import { materializeEffect, unchangedEffect } from "./host-files.ts";
import { checkAnswer, type RunRecord } from "./score.ts";
import type { EvalTask } from "./tasks.ts";

const Details = Schema.Struct({ truncated: Schema.optionalKey(Schema.Boolean) });
const instruction =
  "This is a read-only fixture evaluation. Use only read, grep, find, and ls " +
  "for file access, either directly or inside code_mode. Both routes enforce the same fixture-only " +
  "restriction. Shells, file mutations, background tasks, and paths outside the fixture are unavailable. " +
  "You may compute with code_mode. Do not request unavailable capabilities.";

/** Promise compatibility doors for standalone SDK callers. */
export function materialize(root: string, task: EvalTask): Promise<void> {
  return Effect.runPromise(
    materializeEffect(root, task).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
}

export function unchanged(root: string, task: EvalTask): Promise<boolean> {
  return Effect.runPromise(unchangedEffect(root, task).pipe(Effect.provide(nodeFilePlatformLayer)));
}

export function messageMetrics(messages: AgentSession["messages"]) {
  let finalAnswer = "";
  let completed = false;
  let codeModeCalls = 0;
  let codeModeErrors = 0;
  let toolResultBytes = 0;
  let codeModeToolResultBytes = 0;
  let directToolResultBytes = 0;
  let resultIndex = 0;
  const largestToolResults: { index: number; tool: string; bytes: number; isError: boolean }[] = [];
  let outerCalls = 0;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCost = 0;
  let codeModeTruncations = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      turns++;
      inputTokens += message.usage.input;
      outputTokens += message.usage.output;
      cacheReadTokens += message.usage.cacheRead;
      cacheWriteTokens += message.usage.cacheWrite;
      estimatedCost += message.usage.cost.total;
      completed = message.stopReason === "stop";
      finalAnswer = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      for (const block of message.content) {
        if (block.type === "toolCall") {
          outerCalls++;
          if (block.name === "code_mode") codeModeCalls++;
        }
      }
    } else if (message.role === "toolResult") {
      const bytes = message.content.reduce(
        (total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
        0,
      );
      toolResultBytes += bytes;
      if (message.toolName === "code_mode") codeModeToolResultBytes += bytes;
      else directToolResultBytes += bytes;
      largestToolResults.push({
        index: resultIndex++,
        tool: message.toolName,
        bytes,
        isError: message.isError,
      });
      largestToolResults.sort((left, right) => right.bytes - left.bytes);
      largestToolResults.length = Math.min(largestToolResults.length, 5);
      if (message.toolName === "code_mode") {
        if (message.isError) codeModeErrors++;
        try {
          if (Schema.decodeUnknownSync(Details)(message.details).truncated) codeModeTruncations++;
        } catch {
          // Early refusal has no details. Dispatch metrics remain independently authoritative.
        }
      }
    }
  }
  return {
    finalAnswer,
    completed,
    codeModeCalls,
    codeModeErrors,
    toolResultBytes,
    codeModeToolResultBytes,
    directToolResultBytes,
    largestToolResults,
    outerCalls,
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCost,
    codeModeTruncations,
  };
}

export interface EpisodeOptions {
  readonly task: EvalTask;
  readonly variant: RunRecord["variant"];
  readonly repetition: number;
  readonly experiment?: "adoption" | "output";
  readonly scratch: string;
  readonly agentDir: string;
  readonly modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  readonly model: NonNullable<CreateAgentSessionOptions["model"]>;
  readonly thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
}

type SessionCleanup = Pick<AgentSession, "abort" | "dispose"> & {
  readonly extensionRunner?:
    | {
        emit(event: { readonly type: "session_shutdown"; readonly reason: "quit" }): Promise<void>;
      }
    | undefined;
};

/** Once owned, shutdown must settle before disposal, even when abort rejects. */
export const closeSessionEffect = (session: SessionCleanup, unhealthy: () => boolean) =>
  Effect.tryPromise({ try: () => session.abort(), catch: () => evaluationError("abort") }).pipe(
    Effect.onExit(() =>
      Effect.gen(function* () {
        const runner = yield* Effect.try({
          try: () => session.extensionRunner,
          catch: () => evaluationError("shutdown"),
        });
        if (runner)
          yield* Effect.tryPromise({
            try: () => runner.emit({ type: "session_shutdown", reason: "quit" }),
            catch: () => evaluationError("shutdown"),
          });
      }),
    ),
    Effect.onExit(() =>
      Effect.try({
        try: () => session.dispose(),
        catch: () => evaluationError("dispose"),
      }),
    ),
    Effect.andThen(
      Effect.suspend(() =>
        unhealthy()
          ? Effect.fail(evaluationError("lifecycle", "Evaluation extension lifecycle failed."))
          : Effect.void,
      ),
    ),
  );

type EpisodePrompt = (session: AgentSession, text: string) => Effect.Effect<void, EvaluationError>;

/** Cooperative deadline, not a forced timeout. A started abort is joined before measurement. */
export const promptWithDeadline = (
  session: Pick<AgentSession, "abort">,
  prompt: Effect.Effect<void, EvaluationError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const timedOut = yield* Ref.make(false);
      const aborted = yield* Ref.make<Exit.Exit<void, EvaluationError> | undefined>(undefined);
      const timer = yield* Effect.sleep(180_000).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* Ref.set(timedOut, true);
            const result = yield* Effect.exit(
              Effect.tryPromise({
                try: () => session.abort(),
                catch: () => evaluationError("abort"),
              }),
            );
            yield* Ref.set(aborted, result);
            // The session is already owned. Keep this abort and its result publication together;
            // SDK abort may wait indefinitely, just as the original cooperative deadline did.
          }).pipe(Effect.uninterruptible),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const promptFailed = yield* prompt.pipe(
        Effect.match({ onSuccess: () => false, onFailure: () => true }),
      );
      yield* Fiber.interrupt(timer);
      const abortResult = yield* Ref.get(aborted);
      if (abortResult && Exit.isFailure(abortResult))
        return yield* Effect.failCause(abortResult.cause);
      return { promptFailed, timedOut: yield* Ref.get(timedOut) };
    }),
  );

export const runEpisodeEffect = Effect.fn("Evaluation.runEpisode")(function* (
  options: EpisodeOptions,
  prompt: EpisodePrompt = (session, text) =>
    Effect.tryPromise({
      try: () => session.prompt(text),
      catch: () => evaluationError("prompt"),
    }),
) {
  const fs = yield* FileSystem.FileSystem;
  const { task, variant, repetition } = options;
  return yield* Effect.acquireUseRelease(
    fs
      .makeTempDirectory({ directory: options.scratch, prefix: "fixture-" })
      .pipe(Effect.mapError(() => evaluationError("fixture"))),
    (directory) =>
      Effect.gen(function* () {
        const root = yield* fs
          .realPath(directory)
          .pipe(Effect.mapError(() => evaluationError("fixture")));
        const dispatch = freshDispatchMetrics();
        let extensionFailed = false;
        const started = yield* Clock.monotonicTimeNanos;
        yield* materializeEffect(root, task);
        const { settings, direct, loader } = yield* Effect.try({
          try: () => {
            const settings = SettingsManager.inMemory({
              compaction: { enabled: false },
              retry: { enabled: false, maxRetries: 0 },
            });
            settings.setProjectTrusted(true);
            const direct = fixtureDefinitions(root, dispatch, false);
            const loader = new DefaultResourceLoader({
              cwd: root,
              agentDir: options.agentDir,
              settingsManager: settings,
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              systemPromptOverride: () => undefined,
              appendSystemPromptOverride: () => [instruction],
              extensionFactories: [
                (pi) =>
                  registerCodeModeApplication(pi, {
                    loadSettings: loadCodePreviewSettings,
                    makeNestedDefinitions: () => fixtureDefinitions(root, dispatch, true),
                    wrapTool: (tool) =>
                      variant === "baseline"
                        ? tool
                        : {
                            ...tool,
                            promptGuidelines:
                              options.experiment === "output"
                                ? [
                                    ...(tool.promptGuidelines ?? []).slice(0, 2),
                                    ...outputGuidelines,
                                  ]
                                : [
                                    ...candidateSelectionGuidelines,
                                    ...(tool.promptGuidelines ?? []).slice(1),
                                  ],
                          },
                  }),
              ],
            });
            return { settings, direct, loader };
          },
          catch: () => evaluationError("setup"),
        });
        yield* Effect.tryPromise({
          try: () => loader.reload(),
          catch: () => evaluationError("setup"),
        });
        const loadFailed = yield* Effect.try({
          try: () => loader.getExtensions().errors.length > 0,
          catch: () => evaluationError("setup"),
        });
        if (loadFailed)
          return yield* evaluationError("setup", "Evaluation extension failed to load.");
        // The fixture is already owned. SDK creation has no abort capability, so keep
        // creation and its cleanup handoff together before fixture removal can proceed.
        // This waits for SDK settlement; only the enclosing supervisor can force exit.
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              createAgentSession({
                cwd: root,
                agentDir: options.agentDir,
                modelRuntime: options.modelRuntime,
                model: options.model,
                thinkingLevel: options.thinkingLevel,
                settingsManager: settings,
                sessionManager: SessionManager.inMemory(root),
                resourceLoader: loader,
                tools: ["read", "grep", "find", "ls", "code_mode"],
                customTools: [direct.read, direct.grep, direct.find, direct.ls],
              }),
            catch: () => evaluationError("create"),
          }),
          (created) =>
            Effect.gen(function* () {
              const session = created.session;
              yield* Effect.tryPromise({
                try: () =>
                  session.bindExtensions({
                    mode: "json",
                    onError: () => {
                      extensionFailed = true;
                    },
                  }),
                catch: () => evaluationError("activate"),
              });
              const active = yield* Effect.try({
                try: () => session.agent.state.tools.map((tool) => tool.name).sort(),
                catch: () => evaluationError("activate"),
              });
              if (
                active.join(",") !== "code_mode,find,grep,ls,read" ||
                extensionFailed ||
                created.modelFallbackMessage
              ) {
                return yield* evaluationError(
                  "activate",
                  "Evaluation session did not activate the exact requested tools and model.",
                );
              }
              // Also prove SDK native-name replacement before allowing a model prompt. This must hit
              // our dispatch guard, never the native read implementation. No sensitive path is probed.
              yield* Effect.tryPromise({
                try: () =>
                  session.agent.state.tools
                    .find((tool) => tool.name === "read")!
                    .execute("eval-boundary-probe", { path: "/__code_mode_eval_outside__" }),
                catch: () => evaluationError("activate"),
              }).pipe(Effect.ignore);
              if (dispatch.boundaryViolations !== 1)
                return yield* evaluationError(
                  "activate",
                  "Direct fixture boundary is not installed.",
                );
              dispatch.boundaryViolations = 0;
              const { timedOut, promptFailed } = yield* promptWithDeadline(
                session,
                prompt(session, task.prompt),
              );
              const measured = yield* Effect.try({
                try: () => messageMetrics(session.messages),
                catch: () => evaluationError("prompt"),
              });
              const clean = yield* unchangedEffect(root, task);
              if (!clean) dispatch.boundaryViolations++;
              const completed =
                measured.completed && !timedOut && !extensionFailed && !promptFailed;
              const { finalAnswer, ...metrics } = measured;
              return {
                task: task.id,
                split: task.split,
                eligible: task.eligible,
                variant,
                repetition,
                ...metrics,
                ...dispatch,
                completed,
                correct:
                  completed &&
                  clean &&
                  dispatch.boundaryViolations === 0 &&
                  checkAnswer(finalAnswer, task),
                elapsedMs: Math.round(
                  Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000,
                ),
              } satisfies RunRecord;
            }),
          (created) => closeSessionEffect(created.session, () => extensionFailed),
        );
      }),
    (directory) =>
      fs
        .remove(directory, { recursive: true, force: true })
        .pipe(Effect.mapError(() => evaluationError("fixture"))),
  );
});

/** Standalone SDK Promise entry; the pilot composes runEpisodeEffect without nested runners. */
export function runEpisode(
  options: EpisodeOptions,
  prompt: (session: AgentSession, text: string) => Promise<void> = (session, text) =>
    session.prompt(text),
): Promise<RunRecord> {
  return Effect.runPromise(
    runEpisodeEffect(options, (session, text) =>
      Effect.tryPromise({
        try: () => prompt(session, text),
        catch: () => evaluationError("prompt"),
      }),
    ).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
}
