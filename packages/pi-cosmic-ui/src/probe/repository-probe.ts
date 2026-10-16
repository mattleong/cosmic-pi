import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import { applyGitNumstat, parseGitStatus } from "../footer/git.ts";
import { isSafeWebUrl } from "../footer/hyperlink.ts";
import { PiExec, type PiExecContract } from "../boundary/host-exec.ts";

const decodePullRequest = decodeUnknownOrUndefined(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      url: Schema.String.check(Schema.makeFilter(isSafeWebUrl)),
    }),
  ),
);

const repositoryProbe = (exec: PiExecContract) => ({
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
        .exec("gh", ["pr", "view", "--json", "number,url"], { cwd, timeout: 3_000 })
        .pipe(
          Effect.map((result) =>
            result.code === 0 ? decodePullRequest(result.stdout) : undefined,
          ),
        ),
    Effect.withSpan("pi-cosmic-ui.probe.pull-request"),
  ),
});

export class RepositoryProbe extends Context.Service<RepositoryProbe>()(
  "pi-cosmic-ui/probe/repository-probe/RepositoryProbe",
  { make: PiExec.useSync(repositoryProbe) },
) {
  static readonly layer = Layer.effect(this, this.make);
}
