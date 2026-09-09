/** Evaluation filesystem effects. The SDK/command entries provide core's file platform Layer. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { evaluationError, FixtureBoundaryError } from "./errors.ts";
import type { EvalTask } from "./tasks.ts";

export const fixturePathEffect = Effect.fn("Evaluation.fixturePath")(function* (
  root: string,
  input: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWithin = (value: string) => {
    const suffix = path.relative(root, value);
    return (
      suffix !== ".." &&
      !suffix.startsWith("../") &&
      !suffix.startsWith("..\\") &&
      !path.isAbsolute(suffix)
    );
  };
  const candidate = path.resolve(root, input);
  if (!isWithin(candidate)) return yield* new FixtureBoundaryError();
  // Realpath also refuses symlink escapes. Fixtures are immutable for the entire session.
  const actual = yield* fs
    .realPath(candidate)
    .pipe(Effect.mapError(() => evaluationError("fixture")));
  if (!isWithin(actual)) return yield* new FixtureBoundaryError();
  return actual;
});

export const materializeEffect = Effect.fn("Evaluation.materialize")(
  function* (root: string, task: EvalTask) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [name, content] of Object.entries(task.files)) {
      const target = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, content, { flag: "wx" });
    }
  },
  Effect.mapError(() => evaluationError("fixture")),
);

export const unchangedEffect = Effect.fn("Evaluation.unchanged")(
  function* (root: string, task: EvalTask) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const actual: string[] = [];
    const visit: (directory: string, prefix: string) => Effect.Effect<void, PlatformError> =
      Effect.fn("Evaluation.visitFixture")(function* (directory: string, prefix: string) {
        for (const name of yield* fs.readDirectory(directory)) {
          const relative = prefix ? `${prefix}/${name}` : name;
          const target = path.join(directory, name);
          // FileSystem.stat follows links. Probe readLink first so even in-fixture or broken
          // links remain unexpected entries, matching the original Dirent-based check.
          const link = yield* fs
            .readLink(target)
            .pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
          if (link) {
            actual.push(`UNEXPECTED:${relative}`);
            continue;
          }
          const info = yield* fs.stat(target);
          if (info.type === "Directory") yield* visit(target, relative);
          else if (info.type === "File") actual.push(relative);
          else actual.push(`UNEXPECTED:${relative}`);
        }
      });
    yield* visit(root, "");
    if (actual.sort().join("\n") !== Object.keys(task.files).sort().join("\n")) return false;
    for (const [name, text] of Object.entries(task.files)) {
      if ((yield* fs.readFileString(path.join(root, name))) !== text) return false;
    }
    return true;
  },
  Effect.mapError(() => evaluationError("fixture")),
);
