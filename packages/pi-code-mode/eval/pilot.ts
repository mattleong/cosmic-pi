/** Opt-in standalone entrypoint. Model-backed work is never part of test or validate. */
import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";
import { formatterTasks, formatterScheduleSeed } from "./formatter-tasks.ts";
import { compareFormatter, formatterGates } from "./formatter-score.ts";
import { formatHistoricalSuccess } from "./formatter.ts";
import { formatCodeModeSuccess } from "../src/tools/format.ts";
import { wordingTasks } from "./wording-tasks.ts";
import { compareWording, wordingGates } from "./wording-score.ts";
import {
  experimentalSelectionGuideline,
  previousSelectionGuideline,
  frozenWordingGuidelines,
} from "./wording.ts";
import { evaluationError, EvaluationError } from "./errors.ts";
import { runEpisodeEffect } from "./host-session.ts";
import type { RunRecord } from "./score.ts";
import type { EvalTask } from "./tasks.ts";
import { ReplayExperimentSchema, replayRefusal, type ReplayExperiment } from "./replay.ts";
import { schedule } from "./schedule.ts";

export interface PilotOptions {
  readonly scratch: string;
  readonly agentDir: string;
  readonly authDir: string;
  readonly output: string;
  readonly provider: string;
  readonly model: string;
  readonly maxSessions: number;
  readonly experiment: ReplayExperiment;
}

const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
// Json validates artifact values without changing key order or the frozen digest encoding.
const compactJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const prettyJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json, { space: 2 }));

const runPilotEffect = Effect.fn("Evaluation.runPilot")(
  function* (options: PilotOptions) {
    const experiment = yield* Schema.decodeUnknownEffect(ReplayExperimentSchema)(
      options.experiment,
    ).pipe(Effect.mapError(() => evaluationError("preflight", replayRefusal)));
    const maxSessions = options.maxSessions;
    if (maxSessions !== 24 && maxSessions !== 48)
      return yield* evaluationError(
        "budget",
        "This frozen confirmation plan requires a cap of exactly 24 or 48 sessions.",
      );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const formatterExperiment = experiment === "formatter";
    const selectedTasks = formatterExperiment ? formatterTasks : wordingTasks;
    const selectedGuidelines = formatterExperiment ? [] : [experimentalSelectionGuideline];
    const score = formatterExperiment ? compareFormatter : compareWording;
    const plan = schedule(experiment, maxSessions);
    const controllerPath = yield* path.fromFileUrl(
      new URL("../src/tools/controller.ts", import.meta.url),
    );
    const controller = yield* fs.readFileString(controllerPath);
    const formatterPath = yield* path.fromFileUrl(
      new URL("../src/tools/format.ts", import.meta.url),
    );
    const formatter = yield* fs.readFileString(formatterPath);
    const comparisonSource = yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("./formatter.ts", import.meta.url)),
    );
    const manifest = {
      version: 5,
      experiment,
      effectiveGuidelines: {
        baseline: frozenWordingGuidelines[formatterExperiment ? "candidate" : "baseline"],
        candidate: frozenWordingGuidelines.candidate,
      },
      gates: formatterExperiment ? formatterGates : wordingGates,
      baseline: formatterExperiment
        ? "historical pretty JSON with compact fallback"
        : [previousSelectionGuideline],
      replacementStartsAt: formatterExperiment ? null : 0,
      formatterComparisonDigest: formatterExperiment ? digest(comparisonSource) : null,
      scheduleSeed: formatterExperiment ? formatterScheduleSeed : null,
      executionLimits: DEFAULT_CODE_MODE_CONFIG,
      provider: options.provider,
      model: options.model,
      thinkingLevel: "medium",
      maxSessions,
      taskDigest: digest(yield* compactJson(selectedTasks)),
      controllerDigest: digest(controller),
      formatterDigest: digest(formatter),
      candidateDigest: formatterExperiment
        ? digest(formatter)
        : digest(yield* compactJson(selectedGuidelines)),
      candidate: formatterExperiment
        ? "production compact JSON; shared frozen benchmark guidance"
        : selectedGuidelines,
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
    const preflightTask: EvalTask = {
      id: "preflight",
      split: "development",
      eligible: false,
      prompt: "",
      files: { VERSION: "1.8.2\n" },
      expected: "1.8.2",
    };
    for (const variant of ["baseline", "candidate"] as const) {
      let preflightPassed = false;
      const preflight = yield* runEpisodeEffect(
        {
          task: preflightTask,
          experiment,
          variant,
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
                      code: formatterExperiment
                        ? "return {version: (await tools.pi.read({path: 'VERSION'})).trim(), flags: [false, 0, null]};"
                        : "return await tools.pi.read({path: 'VERSION'});",
                      intent: "Verify fixture dispatch",
                    },
                    signal,
                  ),
              catch: () => evaluationError("preflight"),
            });
            preflightPassed = result.content.some(
              (block) => block.type === "text" && block.text.includes("1.8.2"),
            );
            if (formatterExperiment) {
              const value = { version: "1.8.2", flags: [false, 0, null] };
              const expected =
                variant === "baseline"
                  ? formatHistoricalSuccess(
                      { ok: true, value },
                      DEFAULT_CODE_MODE_CONFIG.maxOutputBytes,
                    )
                  : formatCodeModeSuccess({ ok: true, value });
              preflightPassed &&=
                result.content.some((block) => block.type === "text" && block.text === expected) &&
                session.agent.state.systemPrompt.includes(experimentalSelectionGuideline) &&
                !session.agent.state.systemPrompt.includes(previousSelectionGuideline);
              yield* Schema.decodeUnknownEffect(
                Schema.Struct({ outputKind: Schema.Literal("structured") }),
              )(result.details).pipe(Effect.mapError(() => evaluationError("preflight")));
            } else {
              const expected =
                variant === "baseline"
                  ? previousSelectionGuideline
                  : experimentalSelectionGuideline;
              const excluded =
                variant === "baseline"
                  ? experimentalSelectionGuideline
                  : previousSelectionGuideline;
              preflightPassed &&=
                session.agent.state.systemPrompt.includes(expected) &&
                !session.agent.state.systemPrompt.includes(excluded);
            }
          }),
      );
      if (
        !preflightPassed ||
        preflight.nestedSucceeded !== 1 ||
        preflight.boundaryViolations !== 0 ||
        (formatterExperiment && preflight.formatter?.changedCalls !== 1)
      ) {
        return yield* evaluationError(
          "preflight",
          "No-inference evaluation preflight failed; no model sessions launched.",
        );
      }
    }
    yield* Effect.log("No-inference SDK/interpreter and active-guidance preflight passed.");
    const records: RunRecord[] = [];
    let attempted = 0;
    let stopped = "budget-exhausted";
    yield* Effect.gen(function* () {
      for (const episode of plan) {
        if (attempted >= maxSessions) break;
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
          `${attempted}/${maxSessions} ${result.task} ${result.variant} correct=${result.correct} code_mode=${result.codeModeCalls} nested=${result.nestedCalls}`,
        );
        if (result.boundaryViolations > 0 || !result.completed) {
          stopped = "safety-or-execution-failure";
          break;
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
            comparison: score(records, plan.length / 2),
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
