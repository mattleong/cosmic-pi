import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import {
  acquireBoundedProcessRunner,
  nodeProcessLayer,
  type BoundedProcessRunner,
} from "pi-cosmic-core/platform/process";

const BRANCH_TIMEOUT_MILLIS = 3_000;
const MAX_OUTPUT_BYTES = 4 * 1024;

const decodeBranch = decodeUnknownOrUndefined(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^\P{Cc}+$/u),
  ),
);

/** The checked-out branch for display, or undefined outside a repository or on a detached HEAD. */
export const makeCurrentBranch =
  (environment: Readonly<NodeJS.ProcessEnv>, processRunner: BoundedProcessRunner) =>
  (cwd: string): Effect.Effect<string | undefined> =>
    processRunner({
      executable: "git",
      args: ["branch", "--show-current"],
      cwd,
      environment: { PATH: environment.PATH, HOME: environment.HOME },
      stdoutLimitBytes: MAX_OUTPUT_BYTES,
      stderrLimitBytes: MAX_OUTPUT_BYTES,
      timeoutMillis: BRANCH_TIMEOUT_MILLIS,
      detached: false,
    }).pipe(
      Effect.map((output) =>
        output.code === 0 && !output.overflowed && !output.timedOut
          ? decodeBranch(Str.trim(output.stdout))
          : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

export class GitBranch extends Context.Service<GitBranch, ReturnType<typeof makeCurrentBranch>>()(
  "pi-rex-btw/git/GitBranch",
) {
  static layer(environment: Readonly<NodeJS.ProcessEnv>) {
    return Layer.effect(
      this,
      Effect.map(acquireBoundedProcessRunner, (runner) => makeCurrentBranch(environment, runner)),
    ).pipe(Layer.provide(nodeProcessLayer));
  }
}
