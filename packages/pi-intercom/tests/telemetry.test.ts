import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import type { intercomLayer } from "../src/layer.ts";
import { listSessions, readSession, sendToSession } from "../src/tools/sessions.ts";
import { sessionRuntime, sharedAgentDirectory } from "./support/session-harness.ts";

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
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.withTracer(tracer),
          Effect.provideService(References.MinimumLogLevel, "All"),
          Effect.provide(
            Logger.layer([
              Logger.make((options) => void logs.push(Logger.formatStructured.log(options))),
            ]),
          ),
        );
      const shared = yield* sharedAgentDirectory();
      yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", shared.agentDirectory));
      const a = yield* capture(
        sessionRuntime(identity("a"), "secret a reply", shared.fallbackRoot),
      );
      const b = yield* capture(
        sessionRuntime(identity("b"), "secret b reply", shared.fallbackRoot),
      );
      const secretText = "secret message body";

      const fromA = <X, E>(
        effect: Effect.Effect<X, E, Layer.Success<ReturnType<typeof intercomLayer>>>,
      ) => capture(Effect.ignore(effect.pipe(Effect.provide(a.context))));
      yield* fromA(listSessions());
      yield* fromA(sendToSession(b.record.sessionId, secretText));
      yield* fromA(readSession(b.record.sessionId));
      yield* fromA(sendToSession("secret-missing-id", secretText));
      b.delivery.setReceiving(false);
      yield* fromA(sendToSession(b.record.sessionId, secretText));

      expect(b.sendMessage).toHaveBeenCalledOnce();
      const telemetry = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        logs,
        spans: Arr.map(spans, (span) => ({
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
        a.record.socket,
        b.record.socket,
      ])
        expect(telemetry).not.toContain(secret);
    }),
  );
});
