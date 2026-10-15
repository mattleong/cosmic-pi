import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { requireNodeExecutable } from "../src/boundary/node-executable.ts";
import { nodeFsPromises as fs } from "./support/node-builtins.ts";

describe("Node executable preflight", () => {
  it.effect("accepts the Node binary running Pi", () => requireNodeExecutable());

  it.effect("fails a launch when an upgrade removed or replaced the Node binary", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("node-executable-");
      const removed = `${directory}/Cellar/node/24.1.0/bin/node`;
      const notExecutable = `${directory}/node`;
      yield* Effect.promise(() => fs.writeFile(notExecutable, "", { mode: 0o600 }));
      for (const executable of [removed, notExecutable]) {
        const error = yield* requireNodeExecutable(executable).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "node_executable_missing" });
        expect(error.message).toContain(executable);
      }
    }).pipe(Effect.scoped),
  );
});
