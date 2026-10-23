import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PiApi } from "pi-cosmic-core";

export class PiExecError extends Schema.TaggedError<
  PiExecError,
  { readonly brand: unique symbol }
>()("PiExecError", {
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

export class PiExec extends Context.Service<PiExec, PiExecContract>()(
  "pi-cosmic-ui/boundary/host-exec/PiExec",
) {
  static readonly layerFrom = (exec: ExtensionAPI["exec"]): Layer.Layer<PiExec> =>
    Layer.succeed(this, makePiExec(exec));
  static readonly layer: Layer.Layer<PiExec, never, PiApi> = Layer.effect(
    this,
    PiApi.useSync((pi) =>
      makePiExec((command, args, execOptions) => pi.exec(command, args, execOptions)),
    ),
  );
}
