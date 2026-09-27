import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { registerTaskSettingsCommand } from "../src/settings/controller.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const harness = (options: { readonly trusted?: boolean; readonly started?: boolean } = {}) => {
  let command: Command | undefined;
  const write = vi.fn(() => Promise.resolve());
  registerTaskSettingsCommand(
    extensionApiFixture({
      registerCommand: (_name: string, registered: Command) => {
        command = registered;
      },
    }),
    {
      config: () =>
        options.started === false
          ? undefined
          : { ...DEFAULT_BACKGROUND_TASK_CONFIG, shellPath: "/bin/\u001b[31mzsh\nspoof" },
      write,
    },
  );
  const notify = vi.fn();
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? true,
    ui: { notify },
  });
  const run = (args: string) => Effect.promise(() => Promise.resolve(command?.handler(args, ctx)));
  return { write, notify, run };
};

describe("/tasks-settings", () => {
  it.effect("shows the settings this session started with, without terminal controls", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("status");
      const [message, level] = h.notify.mock.calls.at(-1) ?? [];
      expect(level).toBe("info");
      expect(message).toContain("maxRunning");
      expect(message).not.toContain("\u001b");
      const idle = harness({ started: false });
      yield* idle.run("status");
      expect(idle.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("writes a checked value to the named scope and refuses the rest", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run("maxRunning 16");
      yield* h.run("project maxWaitSeconds 60");
      expect(h.write.mock.calls).toEqual([
        [{ cwd: "/project", scope: "global" }, "maxRunning", 16],
        [{ cwd: "/project", scope: "project" }, "maxWaitSeconds", 60],
      ]);
      yield* h.run("maxRunning 999");
      expect(h.write).toHaveBeenCalledTimes(2);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("maxRunning"), "error");

      const untrusted = harness({ trusted: false });
      yield* untrusted.run("project maxRunning 4");
      expect(untrusted.write).not.toHaveBeenCalled();
      expect(untrusted.notify).toHaveBeenLastCalledWith(
        expect.stringMatching(/trust/iu),
        "warning",
      );
    }),
  );
});
