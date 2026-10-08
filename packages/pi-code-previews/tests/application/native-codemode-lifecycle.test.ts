// Lifecycle fixture models only public metadata and renderer resolution, never native execution.
import assert from "node:assert/strict";
import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import {
  extensionContextFixture,
  opaqueFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { animationSchedulerProbe, createToolPresentationHarness } from "../../testing";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { getCodePreviewToolStatuses } from "../../src/tools/status";
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
const foreign = {
  source: "other",
  path: "/foreign.ts",
  scope: "user",
  origin: "top-level",
} as const;
const info = (sourceInfo: ToolInfo["sourceInfo"] = builtin): ToolInfo => ({
  name: "codemode",
  description: "native",
  parameters: opaqueFixture({}),
  exposure: "model-only",
  sourceInfo,
});
const downstream: ToolRenderers = {
  renderCall: () => new Text("NATIVE_CALL_RETAINED", 0, 0),
  renderResult: (result) =>
    new Text(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      0,
      0,
    ),
};
const running = {
  content: [],
  details: {
    calls: [{ id: "private/1", name: "read", args: '{"path":"a.ts"}', status: "running" }],
  },
};
function fixture(
  load: (attempt: number) => Effect.Effect<CodePreviewSettings> = () => Effect.succeed(preview),
) {
  const probe = animationSchedulerProbe();
  let active = ["codemode"];
  let visible: ToolInfo | undefined = info();
  let attempt = 0;
  const host = recordingExtensionHost(undefined, {
    getAllTools: () => (visible ? [visible] : []),
    getActiveTools: () => [...active],
    getCommands: () => [],
    registerTool() {
      throw new Error("presentation must not register execution definitions");
    },
    setActiveTools() {
      throw new Error("active names are not renderer policy");
    },
  });
  const ctx = extensionContextFixture({
    cwd: "/project",
    isProjectTrusted: () => true,
    ui: { notify() {} },
  });
  const registered = codePreviewsWithDependencies(host.pi, {
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
    loadSettings: () =>
      load(attempt++).pipe(Effect.tap((value) => Effect.sync(() => setCodePreviewSettings(value)))),
    initializeSyntax: () => Effect.void,
    registerRenderers: () => undefined,
  });
  return {
    probe,
    registered,
    resolvers: host.toolRenderers,
    active: (value: string[]) => {
      active = value;
    },
    activeNames: () => [...active],
    visible: (value: ToolInfo | undefined) => {
      visible = value;
    },
    resolve: (name = "codemode", base = downstream) => host.resolve(name, base)!,
    start: () => host.emit("session_start", ctx),
    shutdown: () => host.emit("session_shutdown", ctx),
  };
}
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

for (const scenario of ["builtin", "inactive", "missing", "foreign", "wrong-builtin-path"] as const)
  it.effect(
    `native renderer admission respects current ${scenario} metadata without changing selection`,
    () =>
      Effect.gen(function* () {
        const h = fixture();
        yield* step(() => h.registered);
        yield* Effect.addFinalizer(() => step(() => h.shutdown()));
        if (scenario === "inactive") h.active([]);
        if (scenario === "missing") h.visible(undefined);
        if (scenario === "foreign") h.visible(info(foreign));
        if (scenario === "wrong-builtin-path")
          h.visible(info({ ...builtin, path: "builtin:unrelated" }));
        const active = h.activeNames();
        yield* step(() => h.start());
        assert.deepEqual(h.activeNames(), active);
        const selected = h.resolve();
        const admitted = scenario === "builtin" || scenario === "inactive";
        assert.equal(
          getCodePreviewToolStatuses().get("codemode")?.state,
          admitted ? "installed" : scenario === "missing" ? "unavailable" : "skipped-conflict",
        );
        const row = createToolPresentationHarness(selected);
        row.call({ code: "// PROGRAM_RETAINED" }, { expanded: true });
        const text = row.render(100).join("\n");
        assert.equal(text.includes("PROGRAM_RETAINED"), admitted);
        assert.equal(text.includes("NATIVE_CALL_RETAINED"), !admitted);
        if (!admitted) assert.equal(selected.renderCall, downstream.renderCall);
      }),
  );

it.effect(
  "native replay keeps its fixed shell and adopts ready presentation through one stable resolver",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = fixture((attempt) =>
        attempt === 0
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(preview),
            )
          : Effect.succeed(preview),
      );
      yield* step(() => h.registered);
      yield* Effect.addFinalizer(() => step(() => h.shutdown()));
      const retained = h.resolve();
      assert.equal(retained.renderShell, "self");
      const row = createToolPresentationHarness(retained);
      row.call({ code: "// PROGRAM_RETAINED" }, { expanded: true });
      assert.ok(row.render(100).join("\n").includes("NATIVE_CALL_RETAINED"));
      const startup = h.start();
      yield* Deferred.await(entered);
      assert.ok(row.render(100).join("\n").includes("NATIVE_CALL_RETAINED"));
      yield* Deferred.succeed(release, undefined);
      yield* step(() => startup);
      assert.ok(row.render(100).join("\n").includes("PROGRAM_RETAINED"));
      assert.equal(retained.renderShell, "self");
      yield* step(() => h.start());
      assert.equal(h.resolvers.length, 1);
      assert.deepEqual(h.activeNames(), ["codemode"]);
    }),
);

it.effect(
  "foreign native ownership appearing during settings I/O retains downstream rendering",
  () =>
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
      const cold = createToolPresentationHarness(h.resolve());
      cold.call({ code: "// PROGRAM_RETAINED" }, { expanded: true });
      const startup = h.start();
      yield* Deferred.await(entered);
      h.visible(info(foreign));
      yield* Deferred.succeed(release, undefined);
      yield* step(() => startup);
      assert.ok(cold.render(100).join("\n").includes("NATIVE_CALL_RETAINED"));
      assert.equal(h.resolve().renderCall, downstream.renderCall);
      assert.equal(getCodePreviewToolStatuses().get("codemode")?.state, "skipped-conflict");
    }),
);

it.effect(
  "native resolver rechecks current sources and never styles missing or unrelated tools",
  () =>
    Effect.gen(function* () {
      const h = fixture();
      yield* step(() => h.registered);
      yield* Effect.addFinalizer(() => step(() => h.shutdown()));
      yield* step(() => h.start());
      assert.equal(h.resolve("unrelated").renderCall, downstream.renderCall);
      h.visible(undefined);
      assert.equal(h.resolve().renderCall, downstream.renderCall);
      h.visible(info(foreign));
      assert.equal(h.resolve().renderCall, downstream.renderCall);
      h.visible(info());
      assert.equal(h.resolve().renderShell, "self");
    }),
);

it.effect("cancelled native startup cannot publish into a retained row after replacement", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const h = fixture((attempt) =>
      attempt === 0
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(preview),
    );
    yield* step(() => h.registered);
    yield* Effect.addFinalizer(() => step(() => h.shutdown()));
    const cold = createToolPresentationHarness(h.resolve());
    cold.call({ code: "// STALE_PROGRAM" }, { expanded: true });
    const stale = h.start();
    yield* Deferred.await(entered);
    yield* step(() => h.start());
    yield* step(() => stale);
    assert.ok(cold.render(100).join("\n").includes("NATIVE_CALL_RETAINED"));
    const current = createToolPresentationHarness(h.resolve());
    current.call({ code: "// CURRENT_PROGRAM" }, { expanded: true });
    assert.ok(current.render(100).join("\n").includes("CURRENT_PROGRAM"));
    assert.equal(h.resolvers.length, 1);
  }),
);

for (const style of ["compact", "preview"] as const)
  for (const expanded of [false, true])
    for (const ending of ["disabled", "replacement", "shutdown", "failed-reload"] as const)
      it.effect(
        `native ${style}/${expanded}/${ending} retires animation without replacing execution`,
        () =>
          Effect.gen(function* () {
            const h = fixture((attempt) =>
              ending === "failed-reload" && attempt > 0
                ? Effect.die("settings unavailable")
                : Effect.succeed({
                    ...preview,
                    tools: ending === "disabled" && attempt > 0 ? [] : ["codemode"],
                    toolCallCollapsedStyle: style,
                  }),
            );
            yield* step(() => h.registered);
            yield* Effect.addFinalizer(() => step(() => h.shutdown()));
            yield* step(() => h.start());
            const old = h.resolve();
            const row = createToolPresentationHarness(old);
            row.call({ code: "return 1;" }, { executionStarted: true, expanded });
            row.result(running, { isPartial: true, expanded });
            row.render();
            const scheduled = h.probe.scheduled;
            assert.ok(scheduled > 0);
            if (ending === "shutdown") yield* step(() => h.shutdown());
            else yield* step(() => h.start());
            let invalidations = 0;
            row.call(
              { code: "return 2;" },
              {
                executionStarted: true,
                expanded,
                invalidate: () => {
                  invalidations++;
                },
              },
            );
            row.render();
            h.probe.tick();
            assert.equal(h.probe.scheduled, scheduled);
            assert.equal(invalidations, 0);
            const retired = createToolPresentationHarness(old);
            retired.call({ code: "return 3;" }, { executionStarted: true, expanded });
            retired.result(running, { isPartial: true, expanded });
            retired.render();
            assert.equal(h.probe.scheduled, scheduled);
            assert.deepEqual(h.activeNames(), ["codemode"]);
            assert.equal(h.resolvers.length, 1);
            if (ending === "disabled" || ending === "shutdown" || ending === "failed-reload")
              assert.equal(h.resolve().renderCall, downstream.renderCall);
          }),
      );
