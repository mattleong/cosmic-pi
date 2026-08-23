import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PiApi } from "pi-cosmic-core";

export class PiExecError extends Schema.TaggedError<PiExecError>()("PiExecError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export interface PiExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}
export interface PiExecContract {
  readonly exec: (
    command: "git" | "gh",
    args: readonly string[],
    options: { readonly cwd: string; readonly timeout: number },
  ) => Effect.Effect<PiExecResult, PiExecError>;
}
export class PiExec extends Context.Service<PiExec, PiExecContract>()(
  "pi-cosmic-ui/boundary/host-exec/PiExec",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const pi = yield* PiApi;
      return PiExec.of({
        exec: (command, args, options) =>
          Effect.tryPromise({
            try: (signal) =>
              pi.exec(command, command === "git" ? ["--no-optional-locks", ...args] : [...args], {
                ...options,
                signal,
              }),
            catch: () =>
              new PiExecError({
                operation: command,
                message: `Unable to inspect ${command === "git" ? "Git" : "pull request"} status.`,
              }),
          }),
      });
    }),
  );
}
