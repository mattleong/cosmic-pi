/** Opt-in standalone entrypoint. Model-backed work is never part of test or validate. */
import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { candidateSelectionGuidelines } from "./candidate.ts";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";
import { outputGuidelines } from "./output-candidate.ts";
import { compareOutput, outputGates } from "./output-score.ts";
import { outputTasks } from "./output-tasks.ts";
import { evaluationError, EvaluationError } from "./errors.ts";
import { runEpisodeEffect } from "./host-session.ts";
import { compare, type RunRecord } from "./score.ts";
import { tasks, type EvalTask } from "./tasks.ts";

export interface PilotOptions {
  readonly scratch: string;
  readonly agentDir: string;
  readonly authDir: string;
  readonly output: string;
  readonly provider: string;
  readonly model: string;
  readonly maxSessions: number;
  readonly experiment?: "adoption" | "output";
}

export function schedule(experiment: "adoption" | "output" = "adoption") {
  return (experiment === "output" ? outputTasks : tasks).flatMap((task, taskIndex) =>
    Array.from({ length: task.split === "development" ? 1 : 2 }, (_, repetition) => {
      const variants =
        (taskIndex + repetition) % 2 === 0
          ? (["baseline", "candidate"] as const)
          : (["candidate", "baseline"] as const);
      return variants.map((variant) => ({ task, variant, repetition }));
    }).flat(),
  );
}

const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
// Json validates artifact values without changing key order or the frozen digest encoding.
const compactJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const prettyJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json, { space: 2 }));

const runPilotEffect = Effect.fn("Evaluation.runPilot")(
  function* (options: PilotOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const experiment = options.experiment ?? "adoption";
    const selectedTasks = experiment === "output" ? outputTasks : tasks;
    const selectedGuidelines =
      experiment === "output" ? outputGuidelines : candidateSelectionGuidelines;
    const score = experiment === "output" ? compareOutput : compare;
    const plan = schedule(experiment);
    if (
      !Number.isSafeInteger(options.maxSessions) ||
      options.maxSessions < 1 ||
      options.maxSessions > 48
    ) {
      return yield* evaluationError(
        "budget",
        "Session budget must be an integer between 1 and 48.",
      );
    }
    const controllerPath = yield* path.fromFileUrl(
      new URL("../src/tools/controller.ts", import.meta.url),
    );
    const controller = yield* fs.readFileString(controllerPath);
    const formatterPath = yield* path.fromFileUrl(
      new URL("../src/tools/format.ts", import.meta.url),
    );
    const formatter = yield* fs.readFileString(formatterPath);
    const manifest = {
      version: 2,
      experiment,
      gates: experiment === "output" ? outputGates : { relativeAdoptionIncrease: 0.1 },
      executionLimits: DEFAULT_CODE_MODE_CONFIG,
      provider: options.provider,
      model: options.model,
      thinkingLevel: "medium",
      maxSessions: options.maxSessions,
      taskDigest: digest(yield* compactJson(selectedTasks)),
      controllerDigest: digest(controller),
      formatterDigest: digest(formatter),
      candidateDigest: digest(yield* compactJson(selectedGuidelines)),
      candidate: selectedGuidelines,
      restriction:
        "read-only fixture tools; real Code Mode interpreter and extension lifecycle; no ambient prompts or extensions",
      decision:
        "Held-out comparison only; no retuning or reruns on held-out data. All failed attempts consume budget.",
      planned: plan.map(({ task, variant, repetition }) => ({
        task: task.id,
        split: task.split,
        eligible: task.eligible,
        variant,
        repetition,
      })),
    };
    yield* fs.writeFileString(
      path.join(options.output, "manifest.json"),
      (yield* prettyJson(manifest)) + "\n",
      {
        flag: "wx",
      },
    );
    // Credentials stay in their existing host store, outside every agent-accessible fixture.
    const modelRuntime = yield* Effect.tryPromise({
      try: (signal) =>
        ModelRuntime.create({
          authPath: path.join(options.authDir, "auth.json"),
          modelsPath: path.join(options.authDir, "models.json"),
          modelsStorePath: path.join(options.authDir, "models-store.json"),
          allowModelNetwork: false,
          signal,
        }),
      catch: () => evaluationError("model"),
    });
    const model = yield* Effect.try({
      try: () => modelRuntime.getModel(options.provider, options.model),
      catch: () => evaluationError("model"),
    });
    if (!model)
      return yield* evaluationError(
        "model",
        "Requested model is absent from the local catalog; no evaluation sessions launched.",
      );
    // No inference: exercise SDK registration, real interpreter dispatch, and cleanup before
    // consuming the first model-backed slot. This cannot change the candidate or task set.
    let preflightPassed = false;
    const preflightTask: EvalTask = {
      id: "preflight",
      split: "development",
      eligible: false,
      prompt: "",
      files: { VERSION: "1.8.2\n" },
      expected: "1.8.2",
    };
    const preflight = yield* runEpisodeEffect(
      {
        task: preflightTask,
        experiment,
        variant: "candidate",
        repetition: 0,
        scratch: options.scratch,
        agentDir: options.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "medium",
      },
      (session) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              session.agent.state.tools
                .find((item) => item.name === "code_mode")!
                .execute(
                  "eval-interpreter-probe",
                  {
                    code: "return await tools.pi.read({path: 'VERSION'});",
                    intent: "Verify fixture dispatch",
                  },
                  signal,
                ),
            catch: () => evaluationError("preflight"),
          });
          preflightPassed = result.content.some(
            (block) => block.type === "text" && block.text.includes("1.8.2"),
          );
        }),
    );
    if (!preflightPassed || preflight.nestedSucceeded !== 1 || preflight.boundaryViolations !== 0) {
      return yield* evaluationError(
        "preflight",
        "No-inference evaluation preflight failed; no model sessions launched.",
      );
    }
    yield* Effect.log("No-inference SDK/interpreter preflight passed.");
    const records: RunRecord[] = [];
    let attempted = 0;
    let stopped = "budget-exhausted";
    yield* Effect.gen(function* () {
      for (const episode of plan) {
        if (attempted >= options.maxSessions) break;
        // Reserve before session creation. Failure never refunds a slot and never triggers a rerun.
        attempted++;
        yield* fs.writeFileString(
          path.join(options.output, "attempts.jsonl"),
          (yield* compactJson({
            attempt: attempted,
            task: episode.task.id,
            variant: episode.variant,
            repetition: episode.repetition,
          })) + "\n",
          { flag: "a" },
        );
        const result = yield* runEpisodeEffect({
          ...episode,
          experiment,
          scratch: options.scratch,
          agentDir: options.agentDir,
          modelRuntime,
          model,
          thinkingLevel: "medium",
        });
        records.push(result);
        yield* fs.writeFileString(
          path.join(options.output, "runs.jsonl"),
          (yield* compactJson(result)) + "\n",
          { flag: "a" },
        );
        yield* Effect.log(
          `${attempted}/${options.maxSessions} ${result.task} ${result.variant} correct=${result.correct} code_mode=${result.codeModeCalls} nested=${result.nestedCalls}`,
        );
        if (result.boundaryViolations > 0 || !result.completed) {
          stopped = "safety-or-execution-failure";
          break;
        }
        if (attempted === 8) {
          const development = score(records, 4);
          yield* fs.writeFileString(
            path.join(options.output, "development.json"),
            (yield* prettyJson(development)) + "\n",
          );
          // Freeze already-declared candidate before confirmation. A failed development
          // correctness gate stops spending rather than tuning until a lucky run passes.
          if (["regression", "invalid-baseline", "incomplete"].includes(development.verdict)) {
            stopped = "development-regression";
            break;
          }
          yield* fs.writeFileString(
            path.join(options.output, "frozen-candidate.json"),
            (yield* compactJson({
              candidateDigest: manifest.candidateDigest,
              taskDigest: manifest.taskDigest,
            })) + "\n",
            { flag: "wx" },
          );
        }
        if (attempted === plan.length) stopped = "complete";
      }
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          stopped = "infrastructure-or-cleanup-failure";
        }),
      ),
      Effect.onExit(() =>
        Effect.gen(function* () {
          const report = {
            attempted,
            stopped,
            development: score(
              records.filter((record) => record.split === "development"),
              4,
            ),
            heldOut: score(
              records.filter((record) => record.split === "held-out"),
              20,
            ),
          };
          yield* fs.writeFileString(
            path.join(options.output, "report.json"),
            (yield* prettyJson(report)) + "\n",
          );
          yield* Effect.log("Evaluation report written.");
        }),
      ),
    );
  },
  Effect.mapError((error) =>
    error instanceof EvaluationError ? error : evaluationError("artifact"),
  ),
);

/** Standalone command host boundary. File services live for this one pilot invocation. */
export function runPilot(options: PilotOptions): Promise<void> {
  return Effect.runPromise(runPilotEffect(options).pipe(Effect.provide(nodeFilePlatformLayer)));
}
