import type { TUI } from "@earendil-works/pi-tui";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { expect, vi } from "vitest";
import { editWithExternalEditor } from "../src/boundary/host-external-editor.ts";

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
        'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "edited\\n", "utf8");\n',
      );
      const { tui, stop, start, requestRender } = tuiFixture();

      const result = yield* Effect.promise(() =>
        editWithExternalEditor(
          tui,
          `${process.execPath} ${script}`,
          "initial",
          new AbortController().signal,
        ),
      );

      expect(result).toBe("edited");
      expect(stop).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(requestRender).toHaveBeenCalledWith(true);
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
        const pidPath = path.join(directory, "pid");
        yield* fs.writeFileString(
          script,
          '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n',
        );
        const services = yield* Effect.context<never>();
        const { tui, start } = tuiFixture();
        const controller = new AbortController();
        const editing = editWithExternalEditor(
          tui,
          `${process.execPath} ${script} ${pidPath}`,
          "initial",
          controller.signal,
        );
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            Effect.runPromiseWith(services)(fs.readFileString(pidPath)).then((pid) => {
              expect(pid).toMatch(/^\d+$/u);
            }),
          ),
        );
        controller.abort();
        const result = yield* Effect.promise(() => editing);
        expect(result).toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
      }),
  );
});
