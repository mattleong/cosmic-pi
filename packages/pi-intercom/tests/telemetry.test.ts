import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { nodeFilePlatformLayer, synchronousRandomHex } from "pi-cosmic-core";
import { makeCapturedTracer } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { listSessions, readSession, sendToSession } from "../src/tools/sessions.ts";
import {
  sessionRuntime,
  sharedAgentDirectory,
  writeForeignRecord,
  type SessionRuntimeServices,
} from "./support/session-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const identity = (label: string) => ({
  sessionId: `secret-${label}-id`,
  name: `secret-${label}-name`,
  cwd: `/secret/${label}-cwd`,
});

layer(nodeFilePlatformLayer)("intercom telemetry", (it) => {
  it.effect("keeps message text, identities, paths, and tokens out of logs and spans", () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const tracer = makeCapturedTracer();
      const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(tracer.layer),
          Effect.provideService(References.MinimumLogLevel, "All"),
          Effect.provide(
            Logger.layer([
              Logger.make((options) => void logs.push(Logger.formatStructured.log(options))),
            ]),
          ),
        );
      const shared = yield* sharedAgentDirectory();
      const a = yield* capture(sessionRuntime(identity("a"), "secret a reply", shared));
      const b = yield* capture(sessionRuntime(identity("b"), "secret b reply", shared));
      const secretText = "secret message body";

      const fromA = <X, E>(effect: Effect.Effect<X, E, SessionRuntimeServices>) =>
        capture(Effect.ignore(effect.pipe(Effect.provide(a.context))));
      yield* fromA(listSessions());
      yield* fromA(sendToSession(b.record.sessionId, secretText));
      yield* fromA(readSession(b.record.sessionId));
      yield* TestClock.withLive(fromA(sendToSession("secret-missing-id", secretText)));
      // A record naming b's socket under another token: b refuses the caller's proof.
      const foreignToken = synchronousRandomHex(32);
      yield* writeForeignRecord(shared, "secret-foreign-id", {
        socket: b.record.socket,
        token: foreignToken,
      });
      yield* TestClock.withLive(fromA(sendToSession("secret-foreign-id", secretText)));
      b.delivery.setReceiving(false);
      yield* fromA(sendToSession(b.record.sessionId, secretText));

      expect(b.sendMessage).toHaveBeenCalledOnce();
      const telemetry = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        logs,
        spans: Arr.map(tracer.spans, (span) => ({
          name: span.name,
          attributes: [...span.attributes],
          events: span.events,
        })),
      });
      expect(telemetry).toContain("woken");
      expect(telemetry).toContain("session_receive_disabled");
      for (const secret of [
        secretText,
        "secret",
        shared.base,
        a.record.token,
        b.record.token,
        foreignToken,
        a.record.socket,
        b.record.socket,
      ])
        expect(telemetry).not.toContain(secret);
    }),
  );
});
