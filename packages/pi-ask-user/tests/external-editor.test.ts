import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { expect, vi } from "vitest";
import { editWithExternalEditor } from "../src/boundary/host-external-editor.ts";
import { tuiFixture } from "pi-cosmic-core/testing";
import * as Predicate from "effect/Predicate";

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

layer(nodeFilePlatformLayer, { excludeTestServices: true })("external editor boundary", (it) => {
  it.effect("runs the configured editor in a scoped process and restores the TUI", () =>
    Effect.gen(function* () {
      const { fs, path, script, command, tui, stop, start, requestRender } = yield* editorScript(
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "edited\\n", "utf8"); await writeFile(`${process.argv[1]}.target`, process.argv[2], "utf8");\n',
      );

      const result = yield* editWithExternalEditor(tui, command, "initial");

      expect(result).toBe("edited");
      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
      const editedFile = yield* fs.readFileString(`${script}.target`);
      expect(yield* fs.exists(path.dirname(editedFile))).toBe(false);
    }),
  );

  it.effect("restores the TUI and fails with a typed redacted error on a nonzero exit", () =>
    Effect.gen(function* () {
      const { script, command, tui, stop, start, requestRender } = yield* editorScript(
        "process.exit(3);\n",
        "failing-editor.mjs",
      );

      const failure = yield* Effect.flip(editWithExternalEditor(tui, command, "initial"));
      expect(Predicate.isTagged(failure, "ExternalEditorError")).toBe(true);
      expect(failure.message).not.toContain(script);

      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
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
      const editing = yield* Effect.forkChild(
        editWithExternalEditor(tui, `${command} ${statePath}`, "initial"),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          Effect.runPromiseWith(services)(fs.readFileString(statePath)).then((raw) => {
            decodeHangingEditorState(raw);
            return undefined;
          }),
        ),
      );
      yield* Fiber.interrupt(editing);
      expect(start).toHaveBeenCalledOnce();
      const state = decodeHangingEditorState(yield* fs.readFileString(statePath));
      expect(() => process.kill(state.pid, 0)).toThrow();
      expect(yield* fs.exists(path.dirname(state.target))).toBe(false);
    }),
  );
});
