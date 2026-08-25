import type { TUI } from "@earendil-works/pi-tui";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { expect, vi } from "vitest";
import { editWithExternalEditor } from "../src/boundary/host-external-editor.ts";

const decodeHangingEditorState = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, target: Schema.String })),
);

const tuiFixture = () => {
  const stop = vi.fn();
  const start = vi.fn();
  const requestRender = vi.fn();
  const tuiMethods: Pick<TUI, "stop" | "start" | "requestRender"> = {
    stop,
    start,
    requestRender,
  };
  // SAFETY: The editor boundary uses only these three TUI methods.
  return { tui: tuiMethods as TUI, stop, start, requestRender };
};

layer(nodeFilePlatformLayer)("external editor boundary", (it) => {
  it.effect("runs the configured editor in a scoped process and restores the TUI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-editor-test-" });
      const script = path.join(directory, "editor.mjs");
      yield* fs.writeFileString(
        script,
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "edited\\n", "utf8"); await writeFile(`${process.argv[1]}.target`, process.argv[2], "utf8");\n',
      );
      const { tui, stop, start, requestRender } = tuiFixture();
      const command = `${process.execPath} ${script}`;

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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-ask-user-editor-preabort-test-",
      });
      const script = path.join(directory, "editor.mjs");
      const marker = path.join(directory, "spawned");
      yield* fs.writeFileString(
        script,
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "spawned", "utf8");\n',
      );
      const { tui, stop, start } = tuiFixture();
      const command = `${process.execPath} ${script} ${marker}`;
      const controller = new AbortController();
      controller.abort();

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(tui, command, "initial", controller.signal),
      );

      expect(result).toBeUndefined();
      expect(stop).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(yield* fs.exists(marker)).toBe(false);
    }),
  );

  it.effect("restores the TUI and fails with a typed redacted error on a nonzero exit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-ask-user-editor-failure-test-",
      });
      const script = path.join(directory, "failing-editor.mjs");
      yield* fs.writeFileString(script, "process.exit(3);\n");
      const { tui, stop, start, requestRender } = tuiFixture();
      const command = `${process.execPath} ${script}`;

      yield* Effect.promise(() =>
        expect(
          editWithExternalEditor(tui, command, "initial", new AbortController().signal),
        ).rejects.toMatchObject({
          _tag: "ExternalEditorError",
          message: expect.not.stringContaining(script),
        }),
      );

      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
    }),
  );

  it.effect("strips terminal controls while preserving document text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-ask-user-editor-sanitize-test-",
      });
      const script = path.join(directory, "editor.mjs");
      yield* fs.writeFileString(
        script,
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "# Heading\\n\\t**body**\\u001b[31m red\\u001b[0m\\u001b]0;private title\\u0007\\n", "utf8");\n',
      );
      const { tui } = tuiFixture();
      const command = `${process.execPath} ${script}`;

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(tui, command, "initial", new AbortController().signal),
      );

      expect(result).toBe("# Heading\n\t**body** red");
    }),
  );

  it.effect.skipIf(process.platform === "win32")(
    "force-kills an editor that ignores graceful cancellation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "pi-ask-user-editor-abort-test-",
        });
        const script = path.join(directory, "hanging-editor.mjs");
        const statePath = path.join(directory, "state");
        yield* fs.writeFileString(
          script,
          '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, target: process.argv[3] })); setInterval(() => {}, 1000);\n',
        );
        const services = yield* Effect.context<never>();
        const { tui, start } = tuiFixture();
        const controller = new AbortController();
        const editing = editWithExternalEditor(
          tui,
          `${process.execPath} ${script} ${statePath}`,
          "initial",
          controller.signal,
        );
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            Effect.runPromiseWith(services)(fs.readFileString(statePath)).then((raw) => {
              decodeHangingEditorState(raw);
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
