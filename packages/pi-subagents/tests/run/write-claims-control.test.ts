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
  contactParentFrame,
  localServiceFixture,
  withService,
} from "./fixtures/service-harness.ts";
import { stringContaining } from "../support/matchers.ts";
import { SubagentWriterConflictError } from "../../src/run/errors.ts";

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
  it.effect("grants and revokes claims while a claim requester waits for the parent", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("claim-requester", ["src/a.ts"]));
      yield* service.start(writer("claim-peer", ["src/b.ts"]));

      const premature = yield* service.grantWriteClaims(first.id, ["src/c.ts"]).pipe(Effect.flip);
      expect(premature).toMatchObject({ code: "write_claim_change_not_waiting" });

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "claim-question-tool",
        toolName: "contact_parent",
        args: { kind: "question", message: "May I also edit src/c.ts?" },
      });
      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "claude-claim-question-tool",
        toolName: "mcp__pi_subagents_supervisor__supervisor_question",
        args: { message: "May I also edit src/c.ts?" },
      });
      fake.controls[0]?.offerIpc(
        contactParentFrame("claim-question", "question", "May I also edit src/c.ts?"),
      );
      yield* yieldUntil(() => latest(projections, first.id)?.state === "waiting_for_parent");

      const overlap = yield* service.grantWriteClaims(first.id, ["src/b.ts"]).pipe(Effect.flip);
      expect(overlap).toBeInstanceOf(SubagentWriterConflictError);
      const tooMany = yield* service
        .grantWriteClaims(
          first.id,
          Array.from({ length: 64 }, (_, index) => `src/generated-${index}.ts`),
        )
        .pipe(Effect.flip);
      expect(tooMany).toMatchObject({ code: "too_many_write_claims" });

      const granted = yield* service.grantWriteClaims(first.id, ["src/c.ts"]);
      expect(granted.writeClaims).toEqual(["src/a.ts", "src/c.ts"]);
      const revoked = yield* service.revokeWriteClaims(first.id, ["src/a.ts"]);
      expect(revoked.writeClaims).toEqual(["src/c.ts"]);
      const empty = yield* service.revokeWriteClaims(first.id, ["src/c.ts"]).pipe(Effect.flip);
      expect(empty).toMatchObject({ code: "write_claims_cannot_be_empty" });
    });
  });

  it.effect("interrupts an out-of-claim native edit and pauses new writer admission", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(writer("violating-writer", ["src/a.ts"]));
      yield* service.start(writer("peer-writer", ["src/b.ts"]));

      offerEdit(fake.controls[0], "edit-outside-claim", "src/b.ts");
      yield* yieldUntil(() => latest(projections, first.id)?.state === "paused");
      const violated = yield* service.status(first.id);
      expect(violated).toMatchObject({
        writeAdmissionPaused: true,
        writeViolationOffender: true,
        writeAudit: {
          observedFileWrites: ["src/b.ts"],
          violations: [{ path: "src/b.ts", toolName: "edit" }],
        },
      });
      const overlappingRepair = yield* service
        .grantWriteClaims(first.id, ["src/b.ts"])
        .pipe(Effect.flip);
      expect(overlappingRepair).toBeInstanceOf(SubagentWriterConflictError);

      const blocked = yield* service
        .start(writer("new-disjoint-writer", ["src/c.ts"]))
        .pipe(Effect.flip);
      expect(blocked).toBeInstanceOf(SubagentWriterConflictError);
      expect(blocked).toMatchObject({ message: stringContaining("paused") });

      const resumed = yield* service.resumeWriterAdmission(first.id);
      expect(resumed.writeAdmissionPaused).toBeUndefined();
      expect(resumed.writeViolationOffender).toBeUndefined();
      const admitted = yield* service.start(writer("new-disjoint-writer", ["src/c.ts"]));
      expect(admitted.state).toBe("running");

      expect((yield* service.resume(first.id)).state).toBe("running");
      offerEdit(fake.controls[0], "second-edit-outside-claim", "src/c.ts");
      yield* yieldUntil(() => {
        const run = latest(projections, first.id);
        return run?.state === "paused" && run.writeAudit?.violations.length === 2;
      });

      yield* service.stop(first.id);
      const peer = (yield* service.list).find((run) => run.name === "peer-writer");
      if (peer) yield* service.stop(peer.id);
      yield* service.stop(admitted.id);
      const stillBlocked = yield* service
        .start(writer("blocked-after-empty-pool", ["src/d.ts"]))
        .pipe(Effect.flip);
      expect(stillBlocked).toBeInstanceOf(SubagentWriterConflictError);
      expect(stillBlocked).toMatchObject({ message: stringContaining("paused") });
      expect((yield* service.resumeWriterAdmission(first.id)).writeAdmissionPaused).toBeUndefined();
      expect(
        (yield* service.start(writer("admitted-after-empty-pool-review", ["src/d.ts"]))).state,
      ).toBe("running");
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
          writeAdmissionPaused: true,
          writeAudit: { violations: [{ path: "src/outside.ts" }] },
        });
        const blocked = yield* service
          .start(writer("blocked-after-starting-violation", ["src/b.ts"]))
          .pipe(Effect.flip);
        expect(blocked).toBeInstanceOf(SubagentWriterConflictError);
      });
    }),
  );

  it.effect("keeps admission paused until terminal offender cleanup is confirmed", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(writer("cleanup-pending-writer", ["src/a.ts"]));
      const releaseGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(releaseGate);
      offerEdit(fake.controls[0], "cleanup-pending-edit", "src/b.ts");
      yield* yieldUntil(() => latest(projections, run.id)?.state === "paused");

      fake.controls[0]?.offerProtocolError("Fixture terminal failure after containment.");
      yield* yieldUntil(() => latest(projections, run.id)?.state === "failed");
      const cleanupPending = yield* service.resumeWriterAdmission(run.id).pipe(Effect.flip);
      expect(cleanupPending).toMatchObject({
        code: "write_violation_containment_pending",
      });

      fake.controls[0]?.exit(1);
      yield* Deferred.succeed(releaseGate, undefined);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      expect((yield* service.resumeWriterAdmission(run.id)).writeAdmissionPaused).toBeUndefined();
    });
  });
});
