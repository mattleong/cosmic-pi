import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import { McpActivity, makeMcpActivity } from "../../src/activity/service.ts";
import { makeMcpAuthFlow, type McpAuthAttempt } from "../../src/auth/flow.ts";
import type { McpLoginUi } from "../../src/auth/model.ts";
import { authProgress, type McpAuthPhase, type McpAuthProgress } from "../../src/auth/progress.ts";
import { approveScopes } from "../../src/auth/scopes.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { McpExecution, type McpExecutionContract } from "../../src/tools/service.ts";
import { blockingProbe } from "../fixtures/probes.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const ui: McpLoginUi = {
  mode: "local",
  openBrowser: () => Effect.void,
  readCallback: () => Effect.die("No manual callback"),
};
const make = (login: McpExecutionContract["login"]) =>
  Effect.gen(function* () {
    const activity = yield* makeMcpActivity();
    const flow = yield* makeMcpAuthFlow.pipe(
      Effect.provideService(McpActivity, activity),
      Effect.provideService(McpExecution, {
        login,
        logout: () => Effect.die("Cancellation called logout"),
        execute: () => Effect.die("Auth invoked a gateway operation"),
        isAvailable: () => true,
      }),
    );
    let latest: McpAuthProgress | undefined;
    yield* flow.subscribe((progress) => {
      latest = progress;
    });
    return { ...flow, activity, snapshot: () => latest };
  });
const capture = (target: Deferred.Deferred<McpAuthAttempt>) => (attempt: McpAuthAttempt) =>
  Deferred.succeed(target, attempt).pipe(Effect.andThen(Effect.never));
const ready = { state: "ready" } as const;
const awaitCallback = (
  owned: McpLoginUi,
  deadline: number,
  response: Effect.Effect<string | undefined>,
) =>
  owned.waitForCallback!("https://issuer.example/PRIVATE", deadline, response).pipe(
    Effect.as(ready),
  );
const openFailed = () =>
  Effect.fail(
    boundaryError("unavailable", "not-sent", "PRIVATE_ERROR", "oauth-browser-open-failed"),
  );

describe("session-owned explicit-user auth flow", () => {
  for (const consent of [true, false])
    it.effect(`preserves private scope consent through the owned login flow: ${consent}`, () =>
      Effect.gen(function* () {
        let browserAllowed = false;
        const flow = yield* make((_server, owned) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 1000;
            yield* authProgress(owned, { phase: "scope-approval", deadline });
            yield* approveScopes(
              owned,
              { requested: ["PRIVATE_SCOPE"], additions: ["PRIVATE_SCOPE"], source: "challenge" },
              deadline,
            );
            browserAllowed = true;
            return { state: "ready" } as const;
          }),
        );
        const result = yield* flow
          .run("owned", { ...ui, approveScopes: () => Effect.succeed(consent) })
          .pipe(Effect.result);
        expect(result._tag).toBe(consent ? "Success" : "Failure");
        expect(browserAllowed).toBe(consent);
        expect(flow.snapshot()?.phase).toBe(consent ? "succeeded" : "cancelled");
        expect(yield* serialize([flow.snapshot(), flow.activity.snapshot()])).not.toContain(
          "PRIVATE_SCOPE",
        );
      }),
    );
  it.effect(
    "waits for outer finalization, rejects duplicate admission and retains only safe facts",
    () =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const captured = yield* Deferred.make<McpAuthAttempt>();
        const events: McpAuthProgress[] = [];
        let starts = 0;
        const flow = yield* make((_server, ui) =>
          Effect.gen(function* () {
            starts++;
            yield* authProgress(ui, { phase: "storage" });
            yield* authProgress(ui, { phase: "finalizing", credentialsSaved: true });
            yield* Deferred.await(finish);
            return { state: "ready" } as const;
          }),
        );
        yield* flow.subscribe((event) => events.push(event));
        const running = yield* flow
          .run("owned", ui, (attempt) =>
            capture(captured)(attempt).pipe(Effect.onExit(() => attempt.cancel)),
          )
          .pipe(Effect.forkScoped);
        const attempt = yield* Deferred.await(captured);
        yield* yieldUntil(() => flow.snapshot()?.phase === "finalizing");
        expect(flow.snapshot()).toMatchObject({
          phase: "finalizing",
          credentialsSaved: true,
          canReopen: false,
        });
        expect(events.some((event) => event.phase === "succeeded")).toBe(false);
        expect(yield* flow.run("other", ui).pipe(Effect.flip)).toMatchObject({ kind: "busy" });
        expect(starts).toBe(1);
        expect(flow.activity.snapshot()).toHaveLength(1);
        expect(flow.activity.snapshot()[0]).toMatchObject({
          operation: "auth",
          phase: "finalizing",
          status: "running",
        });
        yield* Deferred.succeed(finish, undefined);
        expect(yield* Fiber.join(running)).toEqual({ state: "ready" });
        yield* attempt.cancel;
        expect(flow.snapshot()?.phase).toBe("succeeded");
        expect(flow.activity.snapshot()[0]?.status).toBe("done");
        expect(Object.isFrozen(flow.snapshot())).toBe(true);
      }),
  );

  for (const phase of [
    "waiting-fence",
    "scope-approval",
    "awaiting-callback",
    "exchange",
    "saving",
    "finalizing",
  ] satisfies McpAuthPhase[]) {
    it.effect(
      `cancels the exact attempt during ${phase} and joins cleanup before terminal cancellation`,
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const cleanup = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const captured = yield* Deferred.make<McpAuthAttempt>();
          const flow = yield* make((_server, ui) =>
            authProgress(ui, { phase }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
          );
          const running = yield* flow
            .run("owned", ui, capture(captured))
            .pipe(Effect.result, Effect.forkScoped);
          const attempt = yield* Deferred.await(captured);
          yield* Deferred.await(entered);
          const cancel = yield* attempt.cancel.pipe(Effect.forkScoped);
          yield* Deferred.await(cleanup);
          expect(flow.snapshot()?.phase).toBe("cancelling");
          expect(flow.snapshot()?.canReopen).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(cancel);
          expect((yield* Fiber.join(running))._tag).toBe("Failure");
          expect(flow.snapshot()?.phase).toBe("cancelled");
        }),
    );
  }

  it.effect(
    "reopens only the same validated handoff and keeps browser launch failure recoverable",
    () =>
      Effect.gen(function* () {
        const received = yield* Deferred.make<string>();
        const exchanged = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const captured = yield* Deferred.make<McpAuthAttempt>();
        const secretUrl =
          "https://issuer.example/authorize?state=PRIVATE_STATE&code_challenge=PRIVATE_PKCE";
        let browserOpens = 0;
        let preparations = 0;
        const events: McpAuthProgress[] = [];
        const deadline = (yield* Clock.currentTimeMillis) + 1_000;
        const flow = yield* make((_server, ui) =>
          Effect.gen(function* () {
            preparations++;
            yield* authProgress(ui, { phase: "registration", deadline });
            expect(yield* ui.waitForCallback!(secretUrl, deadline, Deferred.await(received))).toBe(
              "PRIVATE_CALLBACK",
            );
            yield* authProgress(ui, { phase: "exchange", deadline });
            yield* Deferred.succeed(exchanged, undefined);
            yield* Deferred.await(finish);
            return { state: "ready" } as const;
          }),
        );
        yield* flow.subscribe((event) => events.push(event));
        const running = yield* flow
          .run(
            "owned",
            {
              ...ui,
              openBrowser: (url) =>
                Effect.suspend(() => {
                  expect(url).toBe(secretUrl);
                  browserOpens++;
                  return browserOpens === 1 ? openFailed() : Effect.void;
                }),
            },
            capture(captured),
          )
          .pipe(Effect.forkScoped);
        const attempt = yield* Deferred.await(captured);
        yield* yieldUntil(() => flow.snapshot()?.reason === "oauth-browser-open-failed");
        expect(attempt.snapshot().canReopen).toBe(true);
        yield* attempt.reopen;
        expect(preparations).toBe(1);
        expect(browserOpens).toBe(2);
        expect(attempt.snapshot().deadline).toBe(deadline);
        expect(yield* serialize(events)).not.toMatch(/PRIVATE_|issuer\.example/);
        yield* Deferred.succeed(received, "PRIVATE_CALLBACK");
        yield* Deferred.await(exchanged);
        expect(yield* attempt.reopen.pipe(Effect.flip)).toMatchObject({ kind: "stale" });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(running);
        expect(browserOpens).toBe(2);
      }),
  );

  it.effect("rejects duplicate browser actions at admission instead of queuing a late open", () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<McpAuthAttempt>();
      const entered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<string>();
      let opens = 0;
      const deadline = (yield* Clock.currentTimeMillis) + 1_000;
      const flow = yield* make((_server, ui) =>
        awaitCallback(ui, deadline, Deferred.await(response)),
      );
      const running = yield* flow
        .run(
          "owned",
          {
            ...ui,
            openBrowser: () =>
              Effect.sync(() => {
                opens++;
              }).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
              ),
          },
          capture(captured),
        )
        .pipe(Effect.forkScoped);
      const attempt = yield* Deferred.await(captured);
      yield* Deferred.await(entered);
      expect(yield* attempt.reopen.pipe(Effect.flip)).toMatchObject({ kind: "busy" });
      expect(opens).toBe(1);
      yield* Deferred.succeed(response, "PRIVATE_RESPONSE");
      yield* Fiber.join(running);
      expect(opens).toBe(1);
      expect(yield* attempt.reopen.pipe(Effect.flip)).toMatchObject({ kind: "stale" });
    }),
  );

  it.effect(
    "local RPC recovery stays private, reopens explicitly, and closes its dialog on callback",
    () =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<string>();
        const dialog = yield* blockingProbe;
        let opens = 0;
        let dialogs = 0;
        const deadline = (yield* Clock.currentTimeMillis) + 1_000;
        const flow = yield* make((_server, ui) =>
          awaitCallback(ui, deadline, Deferred.await(response)),
        );
        const running = yield* flow
          .run("owned", {
            ...ui,
            openBrowser: () => Effect.suspend(() => (++opens === 1 ? openFailed() : Effect.void)),
            nextAction: (receivedDeadline, failedOpen) =>
              Effect.suspend(() => {
                expect(receivedDeadline).toBe(deadline);
                dialogs++;
                expect(failedOpen).toBe(dialogs === 1);
                return dialogs === 1 ? Effect.succeed("reopen" as const) : dialog.block;
              }),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(dialog.entered);
        expect(opens).toBe(2);
        yield* Deferred.succeed(response, "PRIVATE_CALLBACK");
        yield* Fiber.join(running);
        expect(dialog.released()).toBe(true);
        expect(dialogs).toBe(2);
        expect(yield* serialize([flow.snapshot(), flow.activity.snapshot()])).not.toMatch(
          /PRIVATE_|issuer\.example/,
        );
      }),
  );

  it.effect("local RPC cancel stops this attempt and joins callback cleanup", () =>
    Effect.gen(function* () {
      const receiving = yield* blockingProbe;
      const deadline = (yield* Clock.currentTimeMillis) + 1_000;
      const flow = yield* make((_server, ui) => awaitCallback(ui, deadline, receiving.block));
      expect(
        yield* flow
          .run("owned", {
            ...ui,
            nextAction: () => Deferred.await(receiving.entered).pipe(Effect.as("cancel" as const)),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "cancelled" });
      expect(receiving.released()).toBe(true);
      expect(flow.snapshot()?.phase).toBe("cancelled");
    }),
  );

  it.effect("forwards a confirmed exact-target binding without publishing it", () =>
    Effect.gen(function* () {
      const binding = {
        server: "owned",
        identity: "PRIVATE_IDENTITY",
        configRevision: 7,
        operationRevision: 9,
      };
      const flow = yield* make((_server, _ui, expected) => {
        expect(expected).toBe(binding);
        return Effect.succeed({ state: "ready" } as const);
      });
      yield* flow.run("owned", ui, undefined, binding);
      expect(yield* serialize(flow.snapshot())).not.toContain("PRIVATE_IDENTITY");
    }),
  );

  it.effect("revokes expired actions without extending the SDK deadline", () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<McpAuthAttempt>();
      const deadline = (yield* Clock.currentTimeMillis) + 1_000;
      let opens = 0;
      const flow = yield* make((_server, ui) =>
        awaitCallback(ui, deadline, Effect.never).pipe(
          Effect.timeoutOrElse({
            duration: 1_000,
            orElse: () =>
              Effect.fail(
                boundaryError("timeout", "not-sent", "Expired", "oauth-callback-timeout"),
              ),
          }),
        ),
      );
      const running = yield* flow
        .run(
          "owned",
          {
            ...ui,
            openBrowser: () =>
              Effect.sync(() => {
                opens++;
              }),
          },
          capture(captured),
        )
        .pipe(Effect.result, Effect.forkScoped);
      const attempt = yield* Deferred.await(captured);
      yield* yieldUntil(() => opens === 1);
      yield* TestClock.adjust(1_001);
      expect((yield* Fiber.join(running))._tag).toBe("Failure");
      expect(yield* attempt.reopen.pipe(Effect.flip)).toMatchObject({ kind: "stale" });
      expect(opens).toBe(1);
      expect(flow.snapshot()).toMatchObject({
        phase: "failed",
        reason: "oauth-callback-timeout",
        canReopen: false,
      });
    }),
  );

  for (const saved of [false, true]) {
    it.effect(
      `preserves cancellation's ${saved ? "saved grant" : "unresolved native mutation"} evidence`,
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const captured = yield* Deferred.make<McpAuthAttempt>();
          const flow = yield* make((_server, ui) =>
            authProgress(ui, {
              phase: saved ? "finalizing" : "saving",
              credentialsSaved: saved,
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                authProgress(ui, {
                  phase: saved ? "finalizing" : "saving",
                  credentialsSaved: saved,
                  mutation: saved ? "idle" : "pending",
                }),
              ),
            ),
          );
          const running = yield* flow
            .run("owned", ui, capture(captured))
            .pipe(Effect.result, Effect.forkScoped);
          const attempt = yield* Deferred.await(captured);
          yield* Deferred.await(entered);
          yield* attempt.cancel;
          expect((yield* Fiber.join(running))._tag).toBe("Failure");
          expect(flow.snapshot()).toMatchObject({
            phase: saved ? "failed" : "cancelled",
            credentialsSaved: saved,
            mutation: saved ? "idle" : "pending",
            reason: saved ? "oauth-finalization-failed" : "oauth-mutation-unresolved",
            canReopen: false,
          });
        }),
    );
  }

  it.effect(
    "reports saved-but-finalization-failed without green success or raw error publication",
    () =>
      Effect.gen(function* () {
        const flow = yield* make((_server, ui) =>
          authProgress(ui, { phase: "finalizing", credentialsSaved: true }).pipe(
            Effect.andThen(
              Effect.fail(boundaryError("cleanup", "not-sent", "PRIVATE_PROVIDER_ERROR")),
            ),
          ),
        );
        expect(yield* flow.run("owned", ui).pipe(Effect.flip)).toMatchObject({
          reason: "oauth-finalization-failed",
        });
        expect(flow.snapshot()).toMatchObject({
          phase: "failed",
          credentialsSaved: true,
          reason: "oauth-finalization-failed",
        });
        expect(yield* serialize(flow.snapshot())).not.toContain("PRIVATE_PROVIDER_ERROR");
      }),
  );

  it.effect(
    "an interrupted waiter joins its worker and delayed observers cannot overwrite a replacement",
    () =>
      Effect.gen(function* () {
        const worker = yield* blockingProbe;
        let observer: McpLoginUi["progress"];
        let first = true;
        const flow = yield* make((_server, ui) =>
          Effect.suspend(() => {
            if (!first) return Effect.succeed(ready);
            first = false;
            observer = ui.progress;
            return worker.block;
          }),
        );
        const running = yield* flow.run("owned", ui).pipe(Effect.forkScoped);
        yield* Deferred.await(worker.entered);
        yield* Fiber.interrupt(running);
        expect(worker.released()).toBe(true);
        expect(flow.snapshot()?.phase).toBe("cancelled");
        yield* flow.run("replacement", ui);
        yield* observer!({ phase: "finalizing", credentialsSaved: true });
        expect(flow.snapshot()).toMatchObject({ server: "replacement", phase: "succeeded" });
      }),
  );
});
