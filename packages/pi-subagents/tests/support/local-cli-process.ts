import * as Effect from "effect/Effect";
import type { LocalCliHarnessOptions } from "../../src/boundary/local-cli-harness.ts";
import { LocalCliProcess } from "../../src/boundary/local-cli-process.ts";

/** The service its production Layer builds for these options. */
export const localCliProcess = (options: LocalCliHarnessOptions) =>
  Effect.provide(LocalCliProcess, LocalCliProcess.layer(options));
