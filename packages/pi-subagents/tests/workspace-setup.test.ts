import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runWorkspaceSetup, runWorkspaceVerification } from "../src/boundary/workspace-setup.ts";

const environment = { PATH: "/usr/bin:/bin", GIT_DIR: "/parent/.git" };
const tree = (command: ReadonlyArray<string>, timeoutSeconds?: number) => ({
  command: [...command],
  ...(timeoutSeconds !== undefined && { timeoutSeconds }),
});
const run = (command: ReadonlyArray<string>, timeoutSeconds?: number) =>
  runWorkspaceSetup(tree(command, timeoutSeconds), process.cwd(), { environment });
const verify = (script: string) =>
  runWorkspaceVerification(tree(["/bin/sh", "-c", script]), process.cwd(), { environment });

describe("workspace setup command", () => {
  it.effect("succeeds without the parent's Git variables", () =>
    run(["/bin/sh", "-c", 'test -z "$GIT_DIR"']),
  );

  it.live("stops a command that runs past its timeout", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(["/bin/sh", "-c", "sleep 30"], 1));
      expect(error.message).toContain("timed out after 1s");
    }),
  );
});

describe("workspace verification command", () => {
  it.effect("returns the end of its output, stdout before stderr", () =>
    Effect.gen(function* () {
      const result = yield* verify(
        'i=1; while [ $i -le 100 ]; do echo "line $i"; i=$((i+1)); done; echo done >&2',
      );
      const lines = result.outputTail.split("\n");
      expect(lines.at(-1)).toBe("done");
      expect(lines.at(-2)).toBe("line 100");
      expect(lines).not.toContain("line 1");
      expect(lines.length).toBeLessThan(100);
    }),
  );

  it.effect("fails with its output tail when it exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(verify("echo 'expected 1 to be 2' >&2; exit 1"));
      expect(error.message).toContain("code 1");
      expect(error.cleanupUnconfirmed).not.toBe(true);
      expect(error.outputTail).toContain("expected 1 to be 2");
    }),
  );
});
