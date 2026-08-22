// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { editWithExternalEditor } from "../src/boundary/host-external-editor.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

it("runs the configured editor in a scoped process and restores the TUI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ask-user-editor-test-"));
  temporaryDirectories.push(directory);
  const script = join(directory, "editor.mjs");
  await writeFile(
    script,
    'import { writeFile } from "node:fs/promises"; await writeFile(process.argv[2], "edited\\n", "utf8");\n',
    "utf8",
  );
  const { tui, stop, start, requestRender } = tuiFixture();

  const result = await editWithExternalEditor(
    tui,
    `${process.execPath} ${script}`,
    "initial",
    new AbortController().signal,
  );

  expect(result).toBe("edited");
  expect(stop).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(requestRender).toHaveBeenCalledWith(true);
});

it.skipIf(process.platform === "win32")(
  "force-kills an editor that ignores graceful cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ask-user-editor-abort-test-"));
    temporaryDirectories.push(directory);
    const script = join(directory, "hanging-editor.mjs");
    const pidPath = join(directory, "pid");
    await writeFile(
      script,
      '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n',
      "utf8",
    );
    const { tui, start } = tuiFixture();
    const controller = new AbortController();
    const editing = editWithExternalEditor(
      tui,
      `${process.execPath} ${script} ${pidPath}`,
      "initial",
      controller.signal,
    );
    await vi.waitFor(async () => expect(await readFile(pidPath, "utf8")).toMatch(/^\d+$/u));
    controller.abort();
    await expect(editing).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
  },
);
