import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import { _readOnlyFileSystemTest } from "../src/boundary/read-only-fs.ts";

it.effect("maps rejected close promises and deliberately absorbs cleanup failure", () =>
  Effect.gen(function* () {
    const mappedClose = vi.fn(() => Promise.reject(new Error("native close failed")));
    const error = yield* _readOnlyFileSystemTest
      .closeResource("close-file", "/project/file.ts", mappedClose)
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "AdvisorFileError",
      operation: "close-file",
      path: "/project/file.ts",
      message: "Unable to close project file.",
    });
    expect(mappedClose).toHaveBeenCalledOnce();

    const bestEffortClose = vi.fn(() => Promise.reject(new Error("native close failed")));
    yield* _readOnlyFileSystemTest.closeResourceBestEffort(
      "close-directory",
      "/project/src",
      bestEffortClose,
    );

    expect(bestEffortClose).toHaveBeenCalledOnce();
  }),
);
