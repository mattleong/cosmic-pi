// Lifecycle fixture owns Promise callbacks and mirrors the public visible registry only.
import assert from "node:assert/strict";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { animationSchedulerProbe, createToolPresentationHarness } from "../../testing";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import type { NativeCodemodeDefinition } from "../../src/boundary/host-native-codemode";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { step } from "../support/effect-test";

const preview = {
  ...defaultCodePreviewSettings,
  tools: ["codemode" as const],
  syntaxHighlighting: false,
  toolCallCollapsedStyle: "compact" as const,
  toolCallBackground: "off" as const,
  toolCallTiming: false,
};
const builtin = {
  source: "builtin",
  path: "builtin:codemode",
  scope: "temporary",
  origin: "top-level",
} as const;
const owned = {
  source: "previews",
  path: "/owner.ts",
  scope: "user",
  origin: "top-level",
} as const;
const other = { ...owned, source: "other", path: "/foreign.ts" };
const info = (
  parameters = opaqueFixture({}),
  sourceInfo: ToolInfo["sourceInfo"] = builtin,
): ToolInfo => ({
  name: "codemode",
  description: "native",
  parameters,
  exposure: "model-only",
  sourceInfo,
});
type Handler = (event: Readonly<Record<never, never>>, ctx: ExtensionContext) => Promise<void>;
function fixture(
  load: (attempt: number) => Effect.Effect<CodePreviewSettings> = () => Effect.succeed(preview),
) {
  const handlers = new Map<string, Handler>();
  const registrations: NativeCodemodeDefinition[] = [];
  const probe = animationSchedulerProbe();
  let active = ["codemode"];
  let visible = info();
  let attempt = 0;
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [visible],
    getActiveTools: () => active,
    getCommands: () => [{ name: "code-previews", source: "extension", sourceInfo: owned }],
    getSettings: () => ({}),
    appendEntry() {},
    setActiveTools() {
      throw new Error("active names are not renderer policy");
    },
    registerTool(tool: NativeCodemodeDefinition) {
      registrations.push(tool);
      visible = info(opaqueFixture(tool.parameters), owned);
    },
  });
  const ctx = extensionContextFixture({
    cwd: "/project",
    isProjectTrusted: () => true,
    ui: { notify() {} },
  });
  const registered = codePreviewsWithDependencies(pi, {
    makeRuntime: (api) =>
      makePiManagedRuntime(
        api,
        Layer.merge(
          codePreviewApplicationLayer,
          Layer.succeed(CodePreviewSchedulerService, {
            defer: () => () => undefined,
            schedule: (interval, tick) => probe.schedule(interval, tick)!,
          }),
        ),
      ),
    registerCommands: () => undefined,
    loadStartupSettings: () => Promise.resolve({ nativeMcpPreviews: false }),
    loadSettings: () =>
      load(attempt++).pipe(Effect.tap((value) => Effect.sync(() => setCodePreviewSettings(value)))),
    initializeSyntax: () => Effect.void,
    registerRenderers: (api, cwd, options) =>
      registerToolRenderers(api, cwd, { ...options, toolOptions: {} }),
  });
  return {
    registrations,
    probe,
    registered,
    active: (value: string[]) => {
      active = value;
    },
    foreign: () => {
      visible = info(opaqueFixture(visible.parameters), other);
    },
    start: () => handlers.get("session_start")!({}, ctx),
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
  };
}
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

for (const change of ["late-activation", "foreign-owner"] as const)
  it.effect(`native admission is frozen before async settings: ${change}`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = fixture(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(preview),
        ),
      );
      yield* step(() => h.registered);
      yield* Effect.addFinalizer(() => step(() => h.shutdown()));
      if (change === "late-activation") h.active([]);
      const startup = h.start();
      yield* Deferred.await(entered);
      if (change === "late-activation") h.active(["codemode"]);
      else h.foreign();
      yield* Deferred.succeed(release, undefined);
      yield* step(() => startup);
      assert.equal(h.registrations.length, 0);
    }),
  );

it.effect("cancelled native startup cannot publish after a replacement", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const h = fixture((attempt) =>
      attempt === 0
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(preview),
    );
    yield* step(() => h.registered);
    yield* Effect.addFinalizer(() => step(() => h.shutdown()));
    const stale = h.start();
    yield* Deferred.await(entered);
    h.active([]);
    yield* step(() => h.start());
    yield* step(() => stale);
    assert.equal(h.registrations.length, 0);
    h.active(["codemode"]);
    yield* step(() => h.start());
    assert.equal(h.registrations.length, 1);
  }),
);

for (const style of ["compact", "preview"] as const)
  for (const expanded of [false, true])
    for (const ending of ["disabled", "inactive", "shutdown", "failed-reload"] as const)
      it.effect(
        `native ${style}/${expanded}/${ending} retires renderer animation authority without disabling execution`,
        () =>
          Effect.gen(function* () {
            const h = fixture((attempt) =>
              ending === "failed-reload" && attempt > 0
                ? Effect.die("settings unavailable")
                : Effect.succeed(
                    ending === "disabled" && attempt > 0
                      ? { ...preview, tools: [], toolCallCollapsedStyle: style }
                      : { ...preview, toolCallCollapsedStyle: style },
                  ),
            );
            yield* step(() => h.registered);
            yield* Effect.addFinalizer(() => step(() => h.shutdown()));
            yield* step(() => h.start());
            const old = h.registrations[0];
            assert.ok(old);
            const oldRender = createToolPresentationHarness(old);
            oldRender.call({ code: "return 1;" }, { executionStarted: true, expanded });
            const running = {
              content: [],
              details: {
                calls: [
                  { id: "private/1", name: "read", args: '{"path":"a.ts"}', status: "running" },
                ],
              },
            };
            oldRender.result(running, { isPartial: true, expanded });
            oldRender.render();
            const scheduled = h.probe.scheduled;
            assert.ok(scheduled > 0);
            if (ending === "shutdown") yield* step(() => h.shutdown());
            else {
              if (ending === "inactive") h.active([]);
              yield* step(() => h.start());
            }
            // A retained callback cannot repaint through a replacement owner's scheduler.
            let invalidations = 0;
            oldRender.call(
              { code: "return 2;" },
              {
                executionStarted: true,
                expanded,
                invalidate: () => {
                  invalidations++;
                },
              },
            );
            oldRender.render();
            h.probe.tick();
            assert.equal(h.probe.scheduled, scheduled);
            assert.equal(invalidations, 0);
            const retired = createToolPresentationHarness(old);
            retired.call({ code: "return 3;" }, { executionStarted: true, expanded });
            retired.result(running, { isPartial: true, expanded });
            retired.render();
            assert.equal(h.probe.scheduled, scheduled);
            if (ending === "disabled" || ending === "inactive") {
              const fresh = h.registrations[1];
              assert.ok(fresh);
              assert.notEqual(fresh.execute, old.execute);
              assert.equal(fresh.defaultActive, false);
              assert.equal(fresh.renderShell, undefined);
            }
          }),
      );
