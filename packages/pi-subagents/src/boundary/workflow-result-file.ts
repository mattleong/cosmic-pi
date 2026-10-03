import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Saves a workflow's full result outside the notification, which carries only a clipped copy.
 * The file outlives the session so the main agent can read it later; undefined when saving fails.
 */
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
