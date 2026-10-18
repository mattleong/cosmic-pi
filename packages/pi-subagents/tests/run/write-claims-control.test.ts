import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentProjection } from "../../src/run/model.ts";
import {
  fakeChildLayer,
  type FakeChildControl,
  request,
  localServiceFixture,
  withService,
} from "./fixtures/service-harness.ts";
import { SubagentWriterConflictError } from "../../src/run/errors.ts";
import { isParentActionRequiredRun } from "../../src/run/model.ts";
import {
  OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
  TEMPORARY_DIRECTORY_WRITE_MARKER,
} from "../../src/domain/write-claims.ts";

const writer = (name: string, writes: ReadonlyArray<string>) =>
  request({ name, writeIntent: "writer", writes: [...writes] });

const offerEdit = (control: FakeChildControl | undefined, toolCallId: string, path: string) =>
  control?.offer({
    type: "tool_execution_start",
    toolCallId,
    toolName: "edit",
    args: { path, edits: [] },
  });

const latest = (projections: ReadonlyArray<SubagentProjection>, id: string) =>
  projections.at(-1)?.runs.find((run) => run.id === id);

describe("shared-cwd write claims", () => {
  it.effect("stops only the writer that edits outside its claims", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const offender = yield* service.start(writer("violating-writer", ["src/a.ts"]));
      const peer = yield* service.start(writer("peer-writer", ["src/b.ts"]));

      offerEdit(fake.controls[0], "edit-outside-claim", "src/b.ts");
      yield* yieldUntil(() => latest(projections, offender.id)?.state === "stopped");
      const stopped = yield* service.status(offender.id);
      expect(stopped).toMatchObject({
        writeViolationOffender: true,
        writeAudit: {
          observedFileWrites: ["src/b.ts"],
          violations: [{ path: "src/b.ts", toolName: "edit" }],
        },
      });
      expect(isParentActionRequiredRun(stopped)).toBe(false);
      expect(fake.controls[0]?.released()).toBe(1);

      const untouched = yield* service.status(peer.id);
      expect(untouched.state).toBe("running");
      expect(untouched.writeViolationOffender).toBeUndefined();
      offerEdit(fake.controls[1], "peer-claimed-edit", "src/b.ts");
      yield* yieldUntil(
        () => latest(projections, peer.id)?.writeAudit?.observedFileWrites.length === 1,
      );
      expect((yield* service.status(peer.id)).state).toBe("running");

      // Admission stays open; claims stay disjoint, and the offender's claims are free again.
      expect(
        yield* service.start(writer("overlapping-peer", ["src/b.ts"])).pipe(Effect.flip),
      ).toBeInstanceOf(SubagentWriterConflictError);
      expect((yield* service.start(writer("disjoint-writer", ["src/c.ts"]))).state).toBe("running");
      expect((yield* service.start(writer("relaunched-writer", ["src/a.ts"]))).state).toBe(
        "running",
      );
    });
  });

  it.effect("audits temporary writes and stops a writer that writes outside the workspace", () => {
    const { fake, projections, layer } = localServiceFixture({ temporaryRoots: ["/tmp"] });
    return withService(layer, function* (service) {
      const offender = yield* service.start(writer("outside-writer", ["src/a.ts"]));
      const peer = yield* service.start(writer("outside-peer", ["src/b.ts"]));

      offerEdit(fake.controls[0], "temporary-scratch", "/tmp/scratch.py");
      yield* yieldUntil(
        () =>
          latest(projections, offender.id)?.writeAudit?.observedFileWrites.includes(
            TEMPORARY_DIRECTORY_WRITE_MARKER,
          ) === true,
      );
      const scratched = yield* service.status(offender.id);
      expect(scratched).toMatchObject({ state: "running", writeAudit: { violations: [] } });
      expect(scratched.writeViolationOffender).toBeUndefined();

      offerEdit(fake.controls[0], "relative-escape", "../elsewhere/notes.md");
      yield* yieldUntil(() => latest(projections, offender.id)?.state === "stopped");
      expect(yield* service.status(offender.id)).toMatchObject({
        writeViolationOffender: true,
        writeAudit: { violations: [{ path: OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER }] },
      });
      expect((yield* service.status(peer.id)).state).toBe("running");
      expect((yield* service.start(writer("admitted-beside-offender", ["src/c.ts"]))).state).toBe(
        "running",
      );
    });
  });

  it.effect("stops a starting writer when a violating edit races task issue", () =>
    Effect.gen(function* () {
      const promptGate = yield* Deferred.make<void>();
      const { fake, projections, layer } = localServiceFixture(
        {},
        fakeChildLayer(Effect.void, {
          initialSendGates: [{ spawnIndex: 0, type: "prompt", gate: promptGate }],
        }),
      );
      yield* withService(layer, function* (service) {
        const starting = yield* service
          .start(writer("starting-violator", ["src/a.ts"]))
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("prompt") === true);
        offerEdit(fake.controls[0], "starting-edit-outside-claim", "src/outside.ts");
        yield* yieldUntil(
          () =>
            projections
              .at(-1)
              ?.runs.some((run) => run.name === "starting-violator" && run.state === "stopped") ===
            true,
        );
        Deferred.doneUnsafe(promptGate, Effect.void);
        yield* Fiber.await(starting);
        expect(fake.controls[0]?.released()).toBe(1);
        const stopped = (yield* service.list).find((run) => run.name === "starting-violator");
        expect(stopped).toMatchObject({
          state: "stopped",
          writeViolationOffender: true,
          writeAudit: { violations: [{ path: "src/outside.ts" }] },
        });
        expect(
          (yield* service.start(writer("admitted-after-starting-violation", ["src/b.ts"]))).state,
        ).toBe("running");
      });
    }),
  );
});
