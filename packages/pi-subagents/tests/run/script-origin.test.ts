import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { getFailedStartRecovery } from "../../src/run/launch.ts";
import {
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  request,
  runViews,
  withService,
} from "./fixtures/service-harness.ts";

describe("immutable script-origin subtree policy", () => {
  it.effect("inherits through authenticated readers and ignores spoofed parent ancestry", () => {
    const counts = leaseCounts();
    const f = localServiceFixture({}, undefined, undefined, fakeWriterLeaseLayer({ counts }));
    return withService(f.layer, function* (service) {
      const scripted = yield* service.startScriptSessionOwned(request());
      const unrelated = yield* service.startSessionOwned(request({ cwd: "/unrelated" }));
      const reader = yield* service.startSessionOwnedFrom(
        scripted.id,
        request({ parentRunId: unrelated.id, cwd: "/unrelated" }),
      );
      expect(reader).toMatchObject({ parentRunId: scripted.id, cwd: scripted.cwd, depth: 2 });
      for (const caller of [scripted.id, reader.id]) {
        const denied = yield* service
          .startSessionOwnedFrom(
            caller,
            request({
              writeIntent: "writer",
              parentRunId: unrelated.id,
              cwd: "/unrelated",
            }),
          )
          .pipe(Effect.flip);
        expect(denied).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
        expect(getFailedStartRecovery(denied)).toBeUndefined();
      }
      expect((yield* runViews(service)).map((run) => run.id)).toEqual([
        scripted.id,
        unrelated.id,
        reader.id,
      ]);
      expect(counts.acquire).toBe(0);
      expect(counts.canonicalize).toBe(0);
      expect(f.fake.controls).toHaveLength(3);
    });
  });

  it.effect("preserves model-started nested writers and separately authorized root writers", () => {
    const f = localServiceFixture();
    return withService(f.layer, function* (service) {
      const scripted = yield* service.startScriptSessionOwned(request({ cwd: "/scripted" }));
      const model = yield* service.startSessionOwned(request({ cwd: "/model" }));
      const delegated = yield* service.startSessionOwnedFrom(
        model.id,
        request({ writeIntent: "writer" }),
      );
      const rootWriter = yield* service.startSessionOwned(
        request({ cwd: scripted.cwd, writeIntent: "writer" }),
      );
      expect(delegated).toMatchObject({
        parentRunId: model.id,
        writeIntent: "writer",
        state: "running",
      });
      expect(rootWriter).toMatchObject({
        parentRunId: "root",
        writeIntent: "writer",
        state: "running",
      });
    });
  });
});
