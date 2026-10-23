import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as ChildProcess from "effect/process/ChildProcess";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { nodeProcessLayer } from "pi-cosmic-core/platform/process";
import { stripTerminalControls } from "pi-cosmic-core/security";

const externalEditorLayer = Layer.merge(nodeFilePlatformLayer, nodeProcessLayer);

const inheritedTerminalOptions = {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  killSignal: "SIGTERM",
  forceKillAfter: 1_000,
} satisfies ChildProcess.CommandOptions;

class ExternalEditorError extends Schema.TaggedError<
  ExternalEditorError,
  { readonly brand: unique symbol }
>()("ExternalEditorError", {
  message: Schema.String,
}) {}

export function readExternalEditorCommand(ctx: ExtensionContext): string | undefined {
  try {
    return SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    }).getExternalEditorCommand();
  } catch {
    return undefined;
  }
}

const restoreTui = (tui: TUI) =>
  Effect.try(() => {
    tui.start();
    tui.requestRender(true);
  }).pipe(Effect.ignore);

const editorSession = (tui: TUI, configuredCommand: string | undefined, value: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = configuredCommand ?? "nano";
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-" });
      const file = path.join(directory, "answer.md");
      yield* fs.writeFileString(file, value);
      yield* Effect.acquireRelease(
        Effect.try(() => tui.stop()),
        () => restoreTui(tui),
      );
      const child = yield* ChildProcess.make(
        "/bin/sh",
        ["-c", `exec ${command} "$1"`, "pi-ask-user-editor", file],
        { ...inheritedTerminalOptions, detached: false },
      );
      const status = yield* child.exitCode;
      if (status !== 0)
        return yield* ExternalEditorError.make({
          message: `External editor exited with status ${status}.`,
        });
      return Fn.pipe(
        stripTerminalControls(yield* fs.readFileString(file)),
        Str.replace(/\n$/u, ""),
      );
    }),
  );

// Interruption terminates the editor, removes its temporary file, and restores the TUI before
// the effect settles; callers that join the editor fiber therefore join that cleanup.
export function editWithExternalEditor(
  tui: TUI,
  configuredCommand: string | undefined,
  value: string,
): Effect.Effect<string, ExternalEditorError> {
  return editorSession(tui, configuredCommand, value).pipe(
    Effect.provide(externalEditorLayer, { local: true }),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.findError(cause);
      return Effect.fail(
        Result.isSuccess(error) && Predicate.isTagged(error.success, "ExternalEditorError")
          ? error.success
          : ExternalEditorError.make({ message: "External editor execution failed." }),
      );
    }),
  );
}
