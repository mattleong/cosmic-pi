// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Schema from "effect/Schema";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { LocalPiParentControl } from "../../src/backend/local-pi-protocol.ts";
import { withLocalSupervisorInstructions } from "../../src/backend/local-supervisor-prompt.ts";
import { canonicalResultJson, compileResultContract } from "../../src/domain/result-contract.ts";
import type { RunRecord } from "../../src/run/internal.ts";
import { makeRunStructuredResults } from "../../src/run/structured-result.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { backendLaunch } from "../fixtures/backend-supervisor.ts";
import { view } from "../fixtures/run-view.ts";
import { makeRunContext } from "./fixtures/run-context.ts";
import {
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  request,
  withService,
  type FakeChildControl,
} from "./fixtures/service-harness.ts";

const FINDINGS = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "bad"] },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
} satisfies Schema.Json;
const LABELS = { type: "array", items: { type: "string" } } satisfies Schema.Json;
const OK = { verdict: "ok", findings: ["a.ts"] } satisfies Schema.Json;

const contractFor = (schema: Schema.Json) => compileResultContract(schema).pipe(Effect.orDie);

const submitJson = (control: FakeChildControl, requestId: string, valueJson: string) =>
  control.offerIpc({ channel: "pi-subagents", type: "structured_result", requestId, valueJson });
const submit = (control: FakeChildControl, requestId: string, value: Schema.Json) =>
  submitJson(control, requestId, canonicalResultJson(value));

type StructuredResultAck = Extract<
  LocalPiParentControl,
  { readonly type: "structured_result_ack" }
>;
const ackFor = (control: FakeChildControl, requestId: string) =>
  Effect.gen(function* () {
    const find = () =>
      control.ipc.find(
        (message): message is StructuredResultAck =>
          message.type === "structured_result_ack" && message.requestId === requestId,
      );
    yield* yieldUntil(() => find() !== undefined);
    return find()!;
  });

/** Ends the assignment the way a terminating result tool does: a tool-use turn, then settle. */
const settleAfterToolUse = (control: FakeChildControl) => {
  control.offer({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "subagent_result", arguments: {} }],
    },
  });
  control.offer({ type: "agent_settled" });
};

/** Waits for the run's terminal projection, then reads its status. */
const settled = (
  projections: ReadonlyArray<SubagentProjection>,
  service: SubagentServiceContract,
  runId: string,
) =>
  Effect.gen(function* () {
    yield* yieldUntil(() =>
      (projections.at(-1)?.runs ?? []).some(
        (run) => run.id === runId && (run.state === "completed" || run.state === "failed"),
      ),
    );
    return yield* service.status(runId);
  });

describe("local Pi structured results", () => {
  it.effect("completes with the unwrapped value's canonical JSON after a tool-use turn", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const contract = yield* contractFor(LABELS);
      const run = yield* service.start(request({ resultContract: contract }));
      const control = fake.controls[0]!;
      expect(control.launch.resultContract).toBe(contract);
      submit(control, "result-1", { value: ["b", "a"] });
      expect(yield* ackFor(control, "result-1")).toMatchObject({ ok: true });
      settleAfterToolUse(control);
      const result = yield* settled(projections, service, run.id);
      expect(result.state).toBe("completed");
      expect(result.finalText).toBe(canonicalResultJson(["b", "a"]));
    });
  });

  it.effect("rejects malformed and mismatched submissions with issues and keeps running", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      const control = fake.controls[0]!;
      submitJson(control, "not-json", "{");
      expect(yield* ackFor(control, "not-json")).toMatchObject({ ok: false });
      submit(control, "mismatch", { verdict: "maybe", findings: [] });
      const mismatch = yield* ackFor(control, "mismatch");
      expect(mismatch.ok).toBe(false);
      expect(mismatch.message).toContain("verdict");
      expect((yield* service.status(run.id)).state).toBe("running");
      submit(control, "valid", OK);
      expect(yield* ackFor(control, "valid")).toMatchObject({ ok: true });
    });
  });

  it.effect("keeps the first accepted value and refuses later submissions", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      const control = fake.controls[0]!;
      submit(control, "first", OK);
      expect(yield* ackFor(control, "first")).toMatchObject({ ok: true });
      submit(control, "second", { verdict: "bad", findings: [] });
      expect(yield* ackFor(control, "second")).toMatchObject({ ok: false });
      // A later turn's valid JSON text does not replace the accepted result either.
      control.settle(canonicalResultJson({ verdict: "bad", findings: [] }));
      const result = yield* settled(projections, service, run.id);
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
    });
  });

  it.effect("accepts a result the child wrote as fenced JSON in its final message", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      fake.controls[0]!.settle(`Here it is:\n\`\`\`json\n${JSON.stringify(OK, null, 2)}\n\`\`\``);
      const result = yield* settled(projections, service, run.id);
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
    });
  });

  it.effect("fails a run that settles without any valid result", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      fake.controls[0]!.settle('Everything looks fine: {"verdict": "fine"}');
      const result = yield* settled(projections, service, run.id);
      expect(result.state).toBe("failed");
      expect(result.finalText).toBeUndefined();
      expect(result.error).toBeDefined();
    });
  });

  it.effect("completes with the accepted value when a confirmed pause raced its settlement", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      const control = fake.controls[0]!;
      submit(control, "accepted", OK);
      expect(yield* ackFor(control, "accepted")).toMatchObject({ ok: true });
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      settleAfterToolUse(control);
      const result = yield* settled(projections, service, run.id);
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
    });
  });

  it.effect("completes with the accepted value when it settles while a pause is pending", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      const control = fake.controls[0]!;
      submit(control, "accepted", OK);
      expect(yield* ackFor(control, "accepted")).toMatchObject({ ok: true });
      const abortGate = yield* Deferred.make<void>();
      control.gateNextSend("abort", abortGate);
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.exit, Effect.forkScoped);
      yield* yieldUntil(() => control.sent("abort"));
      settleAfterToolUse(control);
      const result = yield* settled(projections, service, run.id).pipe(
        Effect.ensuring(Deferred.succeed(abortGate, undefined)),
      );
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
      yield* Fiber.join(interrupting);
    });
  });

  it.effect("refuses a result once a pause commits and accepts the resumed assignment's", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ resultContract: yield* contractFor(FINDINGS) }));
      const control = fake.controls[0]!;
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      submit(control, "after-pause", OK);
      expect(yield* ackFor(control, "after-pause")).toMatchObject({ ok: false });

      yield* service.resume(run.id);
      expect(fake.controls).toHaveLength(1);
      submit(control, "resumed", OK);
      expect(yield* ackFor(control, "resumed")).toMatchObject({ ok: true });
      settleAfterToolUse(control);
      const result = yield* settled(projections, service, run.id);
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
    });
  });

  it.effect("keeps the contract on resume and needs a new result for the new assignment", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const contract = yield* contractFor(FINDINGS);
      const run = yield* service.start(request({ resultContract: contract }));
      submit(fake.controls[0]!, "first", OK);
      yield* ackFor(fake.controls[0]!, "first");
      settleAfterToolUse(fake.controls[0]!);
      expect((yield* settled(projections, service, run.id)).state).toBe("completed");
      yield* yieldUntil(() => fake.controls[0]!.released() === 1);

      yield* service.resume(run.id, "Check one more file.");
      const resumed = fake.controls[1]!;
      expect(resumed.launch.resultContract).toBe(contract);
      resumed.settle("Prose only this time.");
      expect((yield* settled(projections, service, run.id)).state).toBe("failed");
    });
  });
});

describe("structured result admission", () => {
  it.effect("refuses submissions from an earlier assignment or an inactive run", () =>
    Effect.gen(function* () {
      const contract = yield* contractFor(FINDINGS);
      const fields = {
        view: view({ state: "running" }),
        stoppedByParent: false,
        assignment: {
          epoch: 2,
          phase: "running" as const,
          attemptToken: "current",
          startedObserved: true,
          outcomeUncertain: false,
          pendingRunSettled: false as const,
        },
      } satisfies Pick<RunRecord, "view" | "stoppedByParent" | "assignment">;
      // SAFETY: Result admission reads only these fields, the launch contract, and its own slot.
      const record = { ...fields, launch: { resultContract: contract } } as RunRecord;
      const answers: Array<{ readonly ok: boolean; readonly message?: string | undefined }> = [];
      const accept = makeRunStructuredResults(yield* makeRunContext());
      const submitted = (assignmentEpoch: number) =>
        accept(record, {
          type: "structured_result",
          assignmentEpoch,
          requestId: `epoch-${assignmentEpoch}`,
          valueJson: canonicalResultJson(OK),
          respond: (ok, message) => Effect.sync(() => void answers.push({ ok, message })),
        });

      yield* submitted(1);
      expect(answers.at(-1)?.ok).toBe(false);
      expect(record.structuredResult).toBeUndefined();
      yield* submitted(2);
      expect(answers.at(-1)?.ok).toBe(true);
      expect(record.structuredResult).toEqual({
        assignmentEpoch: 2,
        json: canonicalResultJson(OK),
      });
      record.stoppedByParent = true;
      record.structuredResult = undefined;
      yield* submitted(2);
      expect(answers.at(-1)?.ok).toBe(false);
      expect(record.structuredResult).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});

describe("native report structured results", () => {
  it.effect("gives CLI agents the result schema with its patterns, which the root skips", () =>
    Effect.gen(function* () {
      const schema = {
        type: "object",
        properties: { code: { type: "string", pattern: "^[A-Z]+$" } },
        required: ["code"],
        additionalProperties: false,
      } satisfies Schema.Json;
      const contract = yield* contractFor(schema);
      const prompt = withLocalSupervisorInstructions(
        backendLaunch({ resultContract: contract }),
      ).systemPrompt;
      expect(prompt).toContain(canonicalResultJson(schema));
    }),
  );

  it.effect("completes with the report's canonical JSON value", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(
        nativeReportRequest({ resultContract: yield* contractFor(FINDINGS) }),
      );
      backend.controls[0]!.report(run.id, 1, "report-1", JSON.stringify(OK, null, 2));
      const result = yield* settled(projections, service, run.id);
      expect(result).toMatchObject({ state: "completed", finalText: canonicalResultJson(OK) });
    });
  });

  it.effect("fails a run whose accepted report is not a valid result", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(
        nativeReportRequest({ resultContract: yield* contractFor(FINDINGS) }),
      );
      backend.controls[0]!.report(run.id, 1, "report-1", "The verdict is ok.");
      const result = yield* settled(projections, service, run.id);
      expect(result.state).toBe("failed");
      expect(result.finalText).toBeUndefined();
    });
  });
});
