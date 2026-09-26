import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makePiExec, PiExecError } from "../src/boundary/host-exec.ts";
import { execOk } from "./support/host.ts";

describe("Pi exec", () => {
  it.effect("builds a boundary that disables Git locks without changing gh arguments", () => {
    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const exec: ExtensionAPI["exec"] = (command, args) => {
      calls.push({ command, args: [...args] });
      return execOk();
    };
    const boundary = makePiExec(exec);

    return Effect.gen(function* () {
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
    });
  });

  it.effect("maps rejected host promises to a typed redacted error", () => {
    const boundary = makePiExec(() => Promise.reject(new Error("secret host failure")));
    return boundary.exec("gh", ["pr", "view"], { cwd: "/project", timeout: 2_000 }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PiExecError);
        expect(error).toMatchObject({
          operation: "gh",
          message: "Unable to inspect pull request status.",
        });
        expect(JSON.stringify(error)).not.toContain("secret host failure");
      }),
    );
  });
});
