// External editor integration is a narrow Node/Pi host boundary.
import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { nodeFilePlatformLayer, nodeProcessLayer, stripTerminalControls } from "pi-cosmic-core";

const externalEditorLayer = Layer.merge(nodeFilePlatformLayer, nodeProcessLayer);

const inheritedTerminalOptions = {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  killSignal: "SIGTERM",
  forceKillAfter: 1_000,
} satisfies ChildProcess.CommandOptions;

class ExternalEditorError extends Schema.TaggedError<ExternalEditorError>()("ExternalEditorError", {
  message: Schema.String,
}) {}

export function captureExternalEditorCommand(ctx: ExtensionContext): string | undefined {
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

const editWithExternalEditorEffect = (
  tui: TUI,
  configuredCommand: string | undefined,
  value: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = configuredCommand ?? (process.platform === "win32" ? "notepad" : "nano");
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-" });
      const file = path.join(directory, "answer.md");
      if (process.platform === "win32" && (file.includes('"') || /[%\p{Cc}]/u.test(file)))
        return yield* new ExternalEditorError({
          message: "External-editor temporary path contains unsupported characters.",
        });
      yield* fs.writeFileString(file, value);
      yield* Effect.acquireRelease(
        Effect.try(() => tui.stop()),
        () => restoreTui(tui),
      );
      const child = yield* process.platform === "win32"
        ? ChildProcess.make(`${command} "${file}"`, { ...inheritedTerminalOptions, shell: true })
        : ChildProcess.make("/bin/sh", ["-c", `exec ${command} "$1"`, "pi-ask-user-editor", file], {
            ...inheritedTerminalOptions,
            detached: false,
          });
      const status = yield* child.exitCode;
      if (status !== 0)
        return yield* new ExternalEditorError({
          message: `External editor exited with status ${status}.`,
        });
      return stripTerminalControls(yield* fs.readFileString(file)).replace(/\n$/u, "");
    }),
  );

export function editWithExternalEditor(
  tui: TUI,
  configuredCommand: string | undefined,
  value: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  const program = Effect.provide(
    editWithExternalEditorEffect(tui, configuredCommand, value),
    externalEditorLayer,
    { local: true },
  );
  return Effect.runPromiseExit(program, { signal }).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    if (signal.aborted) return undefined;
    const failure = Cause.squash(exit.cause);
    if (failure instanceof ExternalEditorError) throw failure;
    throw new ExternalEditorError({ message: "External editor execution failed." });
  });
}
