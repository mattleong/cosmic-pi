import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { applyGitNumstat, parseGitStatus } from "../footer/git.ts";
import type { PiExecContract } from "../boundary/host-exec.ts";

/** Git and pull-request probes; `isCurrent` is rechecked after every process yield. */
export const makeRepositoryProbe = (exec: PiExecContract) => ({
  git: Effect.fn("RepositoryProbe.git")(function* (cwd: string, isCurrent: () => boolean) {
    const status = yield* exec.exec(
      "git",
      ["status", "--short", "--branch", "--untracked-files=normal"],
      { cwd, timeout: 2_000 },
    );
    if (status.code !== 0 || !isCurrent()) return undefined;
    const result = parseGitStatus(status.stdout);
    if (!result || result.staged + result.modified + result.conflicts === 0) return result;
    const diff = yield* exec
      .exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd, timeout: 2_000 })
      .pipe(Effect.option);
    if (!isCurrent()) return undefined;
    return Option.isSome(diff) && diff.value.code === 0
      ? applyGitNumstat(result, diff.value.stdout)
      : result;
  }, Effect.withSpan("pi-cosmic-ui.probe.git")),
  pullRequest: Effect.fn("RepositoryProbe.pullRequest")(
    (cwd: string) =>
      exec
        .exec("gh", ["pr", "view", "--json", "number", "--jq", ".number"], { cwd, timeout: 3_000 })
        .pipe(
          Effect.map((result) => {
            const parsed = Number(result.stdout.trim());
            return result.code === 0 && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
          }),
        ),
    Effect.withSpan("pi-cosmic-ui.probe.pull-request"),
  ),
});
