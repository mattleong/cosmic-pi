import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const saveWorkflowResult = (
  text: string,
  extension: "json" | "txt",
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempFile({
      prefix: "pi-subagents-workflow-",
      suffix: `.${extension}`,
    });
    yield* fs.writeFileString(path, text);
    return path;
  }).pipe(Effect.orElseSucceed(() => undefined));
