import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  ExtensionRunner,
  SessionManager,
  type Extension,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { makeMcpLoginUi } from "../../src/boundary/host-auth.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const makeContext = (
  ui: Pick<ExtensionUIContext, "input" | "confirm"> & Partial<Pick<ExtensionUIContext, "select">>,
) => extensionContextFixture({ mode: "rpc", hasUI: true, isProjectTrusted: () => true, ui });
const exec: ExtensionAPI["exec"] = () => Promise.reject(new Error("Must not open a local browser"));
const host = extensionApiFixture({ exec });

describe("private stock RPC handoff", () => {
  for (const outcome of ["current", "trust", "deadline", "cancel"] as const)
    it.effect(`rejects late permission consent after ${outcome} changes`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const answer = Promise.withResolvers<boolean>();
        let current = true;
        let trusted = true;
        let signal: AbortSignal | undefined;
        const ctx = {
          ...makeContext({
            input: vi.fn(),
            confirm: (_title, _message, options) => {
              signal = options?.signal;
              Deferred.doneUnsafe(entered, Effect.void);
              return answer.promise;
            },
          }),
          isProjectTrusted: () => trusted,
        };
        const ui = makeMcpLoginUi(host, ctx, false, () => current);
        const waiting = yield* ui.approveScopes!(
          { requested: ["PRIVATE_SCOPE"], additions: ["PRIVATE_SCOPE"], source: "challenge" },
          (yield* Clock.currentTimeMillis) + 1000,
        ).pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (outcome === "current") current = false;
        if (outcome === "trust") trusted = false;
        if (outcome === "deadline") yield* TestClock.adjust(1000);
        if (outcome === "cancel") {
          yield* Fiber.interrupt(waiting);
          expect(signal?.aborted).toBe(true);
        }
        answer.resolve(true);
        if (outcome !== "cancel")
          expect(yield* Fiber.join(waiting)).toMatchObject({
            kind: outcome === "deadline" ? "timeout" : "stale",
          });
      }),
    );
  it.effect("does not overlap still-settling native opens or launch after private revocation", () =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return; // The local opener is supported only on macOS.
      const entered = yield* Deferred.make<void>();
      const native = Promise.withResolvers<Awaited<ReturnType<ExtensionAPI["exec"]>>>();
      const completed = { stdout: "", stderr: "", code: 0, killed: false };
      let calls = 0;
      let signal: AbortSignal | undefined;
      const exec: ExtensionAPI["exec"] = (_command, _args, options) => {
        calls++;
        if (calls === 3) throw new Error("PRIVATE_NATIVE_ERROR");
        if (calls !== 1) return Promise.resolve(completed);
        signal = options?.signal;
        Deferred.doneUnsafe(entered, Effect.void);
        return native.promise;
      };
      const host = extensionApiFixture({ exec });
      const ui = makeMcpLoginUi(
        host,
        makeContext({ input: vi.fn(), confirm: vi.fn() }),
        false,
        () => true,
      );
      const first = yield* ui.openBrowser("https://issuer.example/PRIVATE").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      expect(signal?.aborted).toBe(true);
      expect(
        yield* ui.openBrowser("https://issuer.example/PRIVATE").pipe(Effect.flip),
      ).toMatchObject({ kind: "busy" });
      expect(calls).toBe(1);
      native.resolve(completed);
      yield* Effect.promise(() => native.promise);
      expect(
        yield* ui.openBrowser("https://issuer.example/PRIVATE", () => false).pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      expect(calls).toBe(1);
      yield* ui.openBrowser("https://issuer.example/PRIVATE", () => true);
      expect(calls).toBe(2);
      expect(
        yield* ui.openBrowser("https://issuer.example/PRIVATE").pipe(Effect.flip),
      ).toMatchObject({ reason: "oauth-browser-open-failed" });
      yield* ui.openBrowser("https://issuer.example/PRIVATE");
      expect(calls).toBe(4);
    }),
  );

  it.effect("keeps URL and callback outside actual Pi prompt lifecycle publications", () =>
    Effect.gen(function* () {
      const publicEvents: Array<unknown> = [];
      const privateMessages: string[] = [];
      const record = <Event>(event: Event) => {
        publicEvents.push(event);
        return Promise.resolve();
      };
      const extension: Extension = {
        path: "owned-fixture",
        resolvedPath: "owned-fixture",
        sourceInfo: createSyntheticSourceInfo("owned-fixture", { source: "test" }),
        handlers: new Map([
          ["ui_prompt_start", [record]],
          ["ui_prompt_end", [record]],
        ]),
        tools: new Map(),
        commands: new Map(),
        shortcuts: new Map(),
        flags: new Map(),
        messageRenderers: new Map(),
      };
      // The runner does not consult model authority while wrapping or publishing UI prompts.
      const runner = new ExtensionRunner(
        [extension],
        createExtensionRuntime(),
        "/fixture",
        SessionManager.inMemory("/fixture"),
        opaqueFixture({}),
      );
      const privateUi: Pick<ExtensionUIContext, "confirm" | "input"> = {
        confirm: (_title: string, message: string) => {
          privateMessages.push(message);
          return Promise.resolve(true);
        },
        input: () =>
          Promise.resolve(
            "http://127.0.0.1:1234/callback?code=PRIVATE_CALLBACK&state=PRIVATE_STATE",
          ),
      };
      runner.setUIContext(opaqueFixture(privateUi), "rpc");
      const ui = makeMcpLoginUi(host, makeContext(runner.getUIContext()), true, () => true);
      const callback = yield* ui.readCallback(
        "https://issuer.example/authorize?state=PRIVATE_STATE&code_challenge=PRIVATE_PKCE",
      );
      expect(callback).toContain("PRIVATE_CALLBACK");
      expect(
        yield* ui.approveScopes!(
          {
            requested: ["PRIVATE_SCOPE"],
            additions: ["PRIVATE_SCOPE"],
            source: "resource-metadata",
          },
          (yield* Clock.currentTimeMillis) + 1000,
        ),
      ).toBe(true);
      expect(privateMessages).toHaveLength(2);
      expect(privateMessages[0]).toContain("PRIVATE_PKCE");
      expect(privateMessages[1]).toContain("PRIVATE_SCOPE");
      expect(publicEvents).toHaveLength(6);
      expect(yield* serialize(publicEvents)).not.toMatch(/PRIVATE_|issuer\.example|callback\?code/);
    }),
  );

  it.effect(
    "sequences dialogs and derives callback timeout from the unchanged remaining budget",
    () =>
      Effect.gen(function* () {
        const displayed = yield* Deferred.make<void>();
        const inputStarted = yield* Deferred.make<void>();
        const confirmed = Promise.withResolvers<boolean>();
        const callback = Promise.withResolvers<string | undefined>();
        let displayTimeout: number | undefined;
        let inputTimeout: number | undefined;
        let inputSignal: AbortSignal | undefined;
        const ctx = makeContext({
          confirm: (_title, _message, options) => {
            displayTimeout = options?.timeout;
            Deferred.doneUnsafe(displayed, Effect.void);
            return confirmed.promise;
          },
          input: (_title, _placeholder, options) => {
            inputTimeout = options?.timeout;
            inputSignal = options?.signal;
            Deferred.doneUnsafe(inputStarted, Effect.void);
            return callback.promise;
          },
        });
        const ui = makeMcpLoginUi(host, ctx, true, () => true);
        const deadline = (yield* Clock.currentTimeMillis) + 1_000;
        const waiting = yield* ui
          .readCallback("https://issuer.example/authorize?state=PRIVATE", deadline)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(displayed);
        expect(inputTimeout).toBeUndefined();
        yield* TestClock.adjust(400);
        confirmed.resolve(true);
        yield* Deferred.await(inputStarted);
        expect(displayTimeout).toBe(1_000);
        expect(inputTimeout).toBe(600);
        yield* Fiber.interrupt(waiting);
        expect(inputSignal?.aborted).toBe(true);
        callback.resolve("PRIVATE_LATE_CALLBACK");
      }),
  );

  it.effect("uses one signal-owned stock select for local RPC actions without a custom panel", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const chosen = Promise.withResolvers<string | undefined>();
      let signal: AbortSignal | undefined;
      let timeout: number | undefined;
      let title = "";
      const ctx = makeContext({
        input: vi.fn(),
        confirm: vi.fn(),
        select: (value, _choices, options) => {
          title = value;
          signal = options?.signal;
          timeout = options?.timeout;
          Deferred.doneUnsafe(entered, Effect.void);
          return chosen.promise;
        },
      });
      const ui = makeMcpLoginUi(host, ctx, false, () => true);
      const deadline = (yield* Clock.currentTimeMillis) + 1_000;
      const waiting = yield* ui.nextAction!(deadline, true).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect(title).not.toMatch(/https?:|PRIVATE/);
      expect(timeout).toBe(1_000);
      yield* Fiber.interrupt(waiting);
      expect(signal?.aborted).toBe(true);
      chosen.resolve("Reopen browser");
      expect(makeMcpLoginUi(host, ctx, true, () => true).nextAction).toBeUndefined();
      expect(
        makeMcpLoginUi(host, { ...ctx, mode: "tui" }, false, () => true).nextAction,
      ).toBeUndefined();
    }),
  );

  it.effect("does not open callback input after cancel, expiry or revoked authority", () =>
    Effect.gen(function* () {
      const input = vi.fn(() => Promise.resolve("PRIVATE_CALLBACK"));
      for (const confirmed of [false, true]) {
        let current = true;
        const ctx = makeContext({
          confirm: () => {
            if (confirmed) current = false;
            return Promise.resolve(confirmed);
          },
          input,
        });
        const ui = makeMcpLoginUi(host, ctx, true, () => current);
        const result = yield* ui
          .readCallback("https://issuer.example/authorize")
          .pipe(Effect.result);
        expect(result._tag).toBe(confirmed ? "Failure" : "Success");
      }
      const ui = makeMcpLoginUi(host, makeContext({ input, confirm: vi.fn() }), true, () => true);
      expect(
        yield* ui
          .readCallback("https://issuer.example/authorize", yield* Clock.currentTimeMillis)
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "oauth-callback-timeout" });
      expect(input).not.toHaveBeenCalled();
    }),
  );
});
