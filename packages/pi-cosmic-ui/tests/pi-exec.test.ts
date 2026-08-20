// @effect-diagnostics effect/strictEffectProvide:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PiApi } from "pi-cosmic-core";
import { PiExec } from "../src/probe/pi-exec.ts";

describe("Pi exec", () => {
  it.effect("disables optional locks for Git probes without changing gh arguments", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const exec: ExtensionAPI["exec"] = (command, args) => {
      calls.push({ command, args: [...args] });
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const layer = PiExec.layer.pipe(Layer.provide(PiApi.layer({ exec } as ExtensionAPI)));

    return Effect.gen(function* () {
      const boundary = yield* PiExec;
      yield* boundary.exec("git", ["status", "--short"], { cwd: "/project", timeout: 2_000 });
      yield* boundary.exec("git", ["diff", "--numstat", "HEAD", "--"], {
        cwd: "/project",
        timeout: 2_000,
      });
      yield* boundary.exec("gh", ["pr", "view", "--json", "number"], {
        cwd: "/project",
        timeout: 3_000,
      });

      expect(calls).toEqual([
        { command: "git", args: ["--no-optional-locks", "status", "--short"] },
        {
          command: "git",
          args: ["--no-optional-locks", "diff", "--numstat", "HEAD", "--"],
        },
        { command: "gh", args: ["pr", "view", "--json", "number"] },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
