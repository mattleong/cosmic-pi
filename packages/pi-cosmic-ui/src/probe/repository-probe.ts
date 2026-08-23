import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { applyGitNumstat, parseGitStatus, type FooterGitStatus } from "../footer/git.ts";
import { PiExec, type PiExecError } from "../boundary/host-exec.ts";

export interface RepositoryProbeContract {
  readonly git: (
    cwd: string,
    isCurrent?: () => boolean,
  ) => Effect.Effect<FooterGitStatus | undefined, PiExecError>;
  readonly pullRequest: (cwd: string) => Effect.Effect<number | undefined, PiExecError>;
}
export class RepositoryProbe extends Context.Service<RepositoryProbe, RepositoryProbeContract>()(
  "pi-cosmic-ui/probe/repository-probe/RepositoryProbe",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const exec = yield* PiExec;
      const git = Effect.fn("RepositoryProbe.git")(function* (
        cwd: string,
        isCurrent: () => boolean = () => true,
      ) {
        const status = yield* exec.exec(
          "git",
          ["status", "--short", "--branch", "--untracked-files=normal"],
          { cwd, timeout: 2_000 },
        );
        if (status.code !== 0 || !isCurrent()) return undefined;
        let result = parseGitStatus(status.stdout);
        if (!result) return undefined;
        if (result.staged + result.modified + result.conflicts > 0 && isCurrent()) {
          const diff = yield* exec
            .exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd, timeout: 2_000 })
            .pipe(Effect.option);
          if (diff._tag === "Some" && diff.value.code === 0 && isCurrent())
            result = applyGitNumstat(result, diff.value.stdout);
        }
        return result;
      });
      const pullRequest = Effect.fn("RepositoryProbe.pullRequest")((cwd: string) =>
        exec
          .exec("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
            cwd,
            timeout: 3_000,
          })
          .pipe(
            Effect.map((result) => {
              const parsed = Number(result.stdout.trim());
              return result.code === 0 && Number.isInteger(parsed) && parsed > 0
                ? parsed
                : undefined;
            }),
          ),
      );
      return RepositoryProbe.of({
        git: (cwd, isCurrent) =>
          git(cwd, isCurrent).pipe(Effect.withSpan("pi-cosmic-ui.probe.git")),
        pullRequest: (cwd) =>
          pullRequest(cwd).pipe(Effect.withSpan("pi-cosmic-ui.probe.pull-request")),
      });
    }),
  );
}
