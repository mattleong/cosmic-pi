import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runWorkspaceSetup } from "../src/boundary/workspace-setup.ts";

const run = (command: ReadonlyArray<string>, timeoutSeconds?: number) =>
  runWorkspaceSetup(
    { command: [...command], ...(timeoutSeconds !== undefined && { timeoutSeconds }) },
    process.cwd(),
    { PATH: "/usr/bin:/bin", GIT_DIR: "/parent/.git" },
  );

describe("workspace setup command", () => {
  it.effect("succeeds without the parent's Git variables", () =>
    run(["/bin/sh", "-c", 'test -z "$GIT_DIR"']),
  );

  it.effect("reports the exit code and the last output line", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run(["/bin/sh", "-c", "echo progress; echo 'lockfile is stale' >&2; exit 3"]),
      );
      expect(error.message).toContain("exited with code 3");
      expect(error.message).toContain("lockfile is stale");
    }),
  );

  it.live("stops a command that runs past its timeout", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run(["/bin/sh", "-c", "sleep 30"], 1));
      expect(error.message).toContain("timed out after 1s");
    }),
  );
});
