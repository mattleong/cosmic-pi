import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { expect, vi } from "vitest";
import { editWithExternalEditor } from "../src/boundary/host-external-editor.ts";
import { tuiFixture } from "pi-cosmic-core/testing";

const decodeHangingEditorState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, target: Schema.String })),
);

const editorScript = (source: string, name = "editor.mjs") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-editor-test-" });
    const script = path.join(directory, name);
    yield* fs.writeFileString(script, source);
    const stop = vi.fn();
    const start = vi.fn();
    const requestRender = vi.fn();
    const tui = tuiFixture({ stop, start, requestRender });
    const command = `${process.execPath} ${script}`;
    return { fs, path, directory, script, command, tui, stop, start, requestRender };
  });

layer(nodeFilePlatformLayer)("external editor boundary", (it) => {
  it.effect("runs the configured editor in a scoped process and restores the TUI", () =>
    Effect.gen(function* () {
      const { fs, path, script, command, tui, stop, start, requestRender } = yield* editorScript(
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "edited\\n", "utf8"); await writeFile(`${process.argv[1]}.target`, process.argv[2], "utf8");\n',
      );

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(tui, command, "initial", new AbortController().signal),
      );

      expect(result).toBe("edited");
      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
      const editedFile = yield* fs.readFileString(`${script}.target`);
      expect(yield* fs.exists(path.dirname(editedFile))).toBe(false);
    }),
  );

  it.effect("skips TUI mutation and never spawns when the signal is already aborted", () =>
    Effect.gen(function* () {
      const { fs, path, directory, command, tui, stop, start } = yield* editorScript(
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "spawned", "utf8");\n',
      );
      const marker = path.join(directory, "spawned");
      const controller = new AbortController();
      controller.abort();

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(tui, `${command} ${marker}`, "initial", controller.signal),
      );

      expect(result).toBeUndefined();
      expect(stop).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(yield* fs.exists(marker)).toBe(false);
    }),
  );

  it.effect("restores the TUI and fails with a typed redacted error on a nonzero exit", () =>
    Effect.gen(function* () {
      const { script, command, tui, stop, start, requestRender } = yield* editorScript(
        "process.exit(3);\n",
        "failing-editor.mjs",
      );

      const failure = yield* Effect.promise(() =>
        editWithExternalEditor(tui, command, "initial", new AbortController().signal).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(failure).toMatchObject({ _tag: "ExternalEditorError" });
      expect(failure instanceof Error ? failure.message : "").not.toContain(script);

      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
    }),
  );

  it.effect("strips terminal controls while preserving document text", () =>
    Effect.gen(function* () {
      const { command, tui } = yield* editorScript(
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "# Heading\\n\\t**body**\\u001b[31m red\\u001b[0m\\u001b]0;private title\\u0007\\n", "utf8");\n',
      );

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(tui, command, "initial", new AbortController().signal),
      );

      expect(result).toBe("# Heading\n\t**body** red");
    }),
  );

  it.effect("force-kills an editor that ignores graceful cancellation", () =>
    Effect.gen(function* () {
      const { fs, path, directory, command, tui, start } = yield* editorScript(
        '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, target: process.argv[3] })); setInterval(() => {}, 1000);\n',
        "hanging-editor.mjs",
      );
      const statePath = path.join(directory, "state");
      const services = yield* Effect.context();
      const controller = new AbortController();
      const editing = editWithExternalEditor(
        tui,
        `${command} ${statePath}`,
        "initial",
        controller.signal,
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          Effect.runPromiseWith(services)(fs.readFileString(statePath)).then((raw) => {
            decodeHangingEditorState(raw);
            return undefined;
          }),
        ),
      );
      controller.abort();
      const result = yield* Effect.promise(() => editing);
      expect(result).toBeUndefined();
      expect(start).toHaveBeenCalledOnce();
      const state = decodeHangingEditorState(yield* fs.readFileString(statePath));
      expect(() => process.kill(state.pid, 0)).toThrow();
      expect(yield* fs.exists(path.dirname(state.target))).toBe(false);
    }),
  );
});
