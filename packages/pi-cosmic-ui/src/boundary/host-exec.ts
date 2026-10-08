import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PiExecError extends Schema.TaggedError<PiExecError>()("PiExecError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export type PiExecResult = Pick<
  Awaited<ReturnType<ExtensionAPI["exec"]>>,
  "stdout" | "stderr" | "code"
>;
export interface PiExecContract {
  readonly exec: (
    command: "git" | "gh",
    args: readonly string[],
    options: { readonly cwd: string; readonly timeout: number },
  ) => Effect.Effect<PiExecResult, PiExecError>;
}
export const makePiExec = (exec: ExtensionAPI["exec"]): PiExecContract => ({
  exec: (command, args, options) =>
    Effect.tryPromise({
      try: (signal) =>
        exec(command, command === "git" ? ["--no-optional-locks", ...args] : [...args], {
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
