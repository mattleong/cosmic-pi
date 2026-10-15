import { tmpdir } from "node:os";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { deferredPromise, recordingExtensionHost } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
  type CosmicUiHostState,
} from "pi-cosmic-ui/protocol";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import * as SubagentLayers from "../src/layer.ts";
import { SubagentConfigStore } from "../src/config/store.ts";
import { type DelegationMode, subagentConfigDecoder } from "../src/config/schema.ts";
import { DELEGATION_PROMPT_SECTION, NORMAL_START_GUIDELINE } from "../src/delegation/prompt.ts";
import { beforeAgentStartEvent, sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const STATUS_KEY = "pi-subagents.session";

const agentDirectoryWithProfileSet = function* (name: string, delegation?: DelegationMode) {
  const directory = yield* step(() =>
    nodeFsPromises.mkdtemp(nodePath.join(tmpdir(), "pi-subagents-delegation-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => nodeFsPromises.rm(directory, { recursive: true, force: true })),
  );
  yield* step(() =>
    nodeFsPromises.writeFile(
      nodePath.join(directory, "pi-subagents.json"),
      JSON.stringify({
        version: 6,
        ...(delegation && { delegation }),
        defaultProfileSet: name,
        profileSets: { [name]: { profiles: {} } },
      }),
    ),
  );
  return directory;
};

const setup = function* (cosmicUi?: CosmicUiHostState, delegation?: DelegationMode) {
  const agentDirectory = yield* agentDirectoryWithProfileSet("review", delegation);
  const events = createEventBus();
  const upserts: string[] = [];
  let ownerRemoved = false;
  if (cosmicUi) {
    events.on(COSMIC_UI_HOST_QUERY, (data) => normalizeCosmicUiHostQuery(data)?.respond(cosmicUi));
    events.on(COSMIC_UI_FOOTER_UPSERT, (data) => {
      const event = normalizeCosmicFooterUpsertEvent(data);
      if (event?.owner === STATUS_KEY && event.contribution.kind === "text")
        upserts.push(event.contribution.text);
    });
    events.on(COSMIC_UI_FOOTER_REMOVE, (data) => {
      const event = normalizeCosmicFooterRemoveEvent(data);
      if (event?.owner === STATUS_KEY && event.id === undefined) ownerRemoved = true;
    });
  }
  const host = recordingExtensionHost({}, { events });
  registerSubagentApplication(host.pi, {
    getAgentDirectory: () => agentDirectory,
    loadSettings: () => Promise.resolve(),
  });
  const setStatus = vi.fn<(key: string, text: string | undefined) => void>();
  const notify = vi.fn();
  const surface = fakeCustomSurfaceHost();
  let nextMount = deferredPromise();
  const ctx = sessionContextFixture(
    {
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        setStatus,
        notify,
        custom: (factory, options) => {
          const opened = surface.custom(factory, options);
          queueMicrotask(() => {
            surface.mount();
            nextMount.resolve();
            nextMount = deferredPromise();
          });
          return opened;
        },
      },
    },
    "delegation-session",
  );
  const settings = (args: string) =>
    step(
      () => host.commands.get("subagents")?.handler(`settings ${args}`, ctx) ?? Promise.resolve(),
    );
  const prompt = function* (selectedTools = ["read", "subagent_start"]) {
    const startGuidelines = host.tools.get("subagent_start")?.promptGuidelines ?? [];
    const event = beforeAgentStartEvent("Do the work", {
      selectedTools,
      toolGuidelines: { subagent_start: [...startGuidelines] },
    });
    yield* settle(() => host.emit("before_agent_start", ctx, event));
    return {
      section: event.systemPromptOptions.sections[DELEGATION_PROMPT_SECTION],
      startGuidelines: event.systemPromptOptions.toolGuidelines.subagent_start ?? [],
      registeredGuidelines: startGuidelines,
    };
  };
  const status = () => setStatus.mock.calls.findLast(([key]) => key === STATUS_KEY)?.[1];
  return {
    host,
    ctx,
    agentDirectory,
    surface,
    mounted: () => nextMount.promise,
    notify,
    saved: () =>
      step(() =>
        nodeFsPromises.readFile(nodePath.join(agentDirectory, "pi-subagents.json"), "utf8"),
      ).pipe(
        Effect.map((content) =>
          subagentConfigDecoder("global")(
            Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(content),
          ),
        ),
      ),
    settings,
    prompt,
    status,
    upserts,
    ownerRemoved: () => ownerRemoved,
  };
};

// Pause the owned persistence door after inspection, retaining the real document's
// optimistic check and atomic commit. The registered commands and keyboard UI stay real.
const pauseNextDelegationSave = function* () {
  const pending = deferredPromise();
  const started = deferredPromise();
  let entered = false;
  const makeLayer = SubagentLayers.subagentApplicationLayer;
  const capture = vi
    .spyOn(SubagentLayers, "subagentApplicationLayer")
    .mockImplementation((options) =>
      Layer.effectContext(
        Layer.build(makeLayer(options)).pipe(
          Effect.map((context) => {
            const store = Context.get(context, SubagentConfigStore);
            return Context.add(context, SubagentConfigStore, {
              ...store,
              patchDelegation: (...args) =>
                Effect.suspend(() => {
                  if (entered) return store.patchDelegation(...args);
                  entered = true;
                  started.resolve();
                  return Effect.promise(() => pending.promise).pipe(
                    Effect.andThen(store.patchDelegation(...args)),
                  );
                }),
            });
          }),
        ),
      ),
    );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      pending.resolve();
      capture.mockRestore();
    }),
  );
  return { wait: () => started.promise, release: () => pending.resolve() };
};

const globalDelegationRow = (surface: ReturnType<typeof fakeCustomSurfaceHost>) =>
  surface.editor?.render(160).find((line) => line.includes("Global · delegation"));

const openGlobalDelegation = function* (fixture: {
  readonly settings: (args: string) => Effect.Effect<unknown>;
  readonly surface: ReturnType<typeof fakeCustomSurfaceHost>;
  readonly mounted: () => Promise<void>;
}) {
  const mounted = fixture.mounted();
  const picker = yield* fixture.settings("").pipe(Effect.forkScoped);
  yield* step(() => mounted);
  for (let index = 0; index < 5; index += 1) fixture.surface.editor?.handleInput?.("j");
  return picker;
};

describe("delegation mode", () => {
  effectTest(
    "preserves the rapid final Global choice and another row in the same document",
    function* () {
      const gate = yield* pauseNextDelegationSave();
      const fixture = yield* setup({ active: true, ready: true, hidden: [] }, "encouraged");
      yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
      const picker = yield* openGlobalDelegation(fixture);
      fixture.surface.editor?.handleInput?.("\r");
      yield* step(gate.wait);
      for (let index = 0; index < 3; index += 1) fixture.surface.editor?.handleInput?.("\r");
      const nesting = yield* fixture.settings("global maxDepth 3").pipe(Effect.forkScoped);
      gate.release();
      yield* Fiber.join(nesting);
      const saved = yield* fixture.saved();
      expect(saved.file.delegation).toBe("encouraged");
      expect(saved.file.nesting?.maxDepth).toBe(3);
      expect(globalDelegationRow(fixture.surface)).toContain("encouraged");
      expect(fixture.notify.mock.calls.filter(([, level]) => level !== "info")).toEqual([]);
      expect(fixture.upserts.at(-1)).toContain("encouraged");
      fixture.surface.editor?.handleInput?.("\u001b");
      yield* Fiber.join(picker);
      yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    },
  );

  effectTest(
    "reopens from the committed Global value when closed during a pending save",
    function* () {
      const gate = yield* pauseNextDelegationSave();
      const fixture = yield* setup({ active: true, ready: true, hidden: [] }, "encouraged");
      yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
      const picker = yield* openGlobalDelegation(fixture);
      fixture.surface.editor?.handleInput?.("\r");
      yield* step(gate.wait);
      fixture.surface.editor?.handleInput?.("\u001b");
      yield* Fiber.join(picker);
      const mounted = fixture.mounted();
      const reopened = yield* fixture.settings("").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      gate.release();
      yield* step(() => mounted);
      for (let index = 0; index < 5; index += 1) fixture.surface.editor?.handleInput?.("j");
      expect(globalDelegationRow(fixture.surface)).toContain("orchestration");
      expect((yield* fixture.saved()).file.delegation).toBe("orchestration");
      expect(fixture.upserts.at(-1)).toContain("encouraged");
      fixture.surface.editor?.handleInput?.("\u001b");
      yield* Fiber.join(reopened);
      yield* settle(() =>
        fixture.host.emit("session_shutdown", fixture.ctx, {
          type: "session_shutdown",
          reason: "reload",
        }),
      );
      yield* settle(() =>
        fixture.host.emit("session_start", fixture.ctx, {
          type: "session_start",
          reason: "reload",
        }),
      );
      expect(fixture.upserts.at(-1)).toContain("orchestration");
      yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    },
  );

  effectTest("retains a genuine external document conflict and allows the next save", function* () {
    const gate = yield* pauseNextDelegationSave();
    const fixture = yield* setup(undefined, "encouraged");
    yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
    const saving = yield* fixture
      .settings("global delegation orchestration")
      .pipe(Effect.forkScoped);
    yield* step(gate.wait);
    yield* step(() =>
      nodeFsPromises.writeFile(
        nodePath.join(fixture.agentDirectory, "pi-subagents.json"),
        JSON.stringify({
          version: 6,
          delegation: "normal",
          writerWorkspaceMode: "shared-checkout",
        }),
      ),
    );
    gate.release();
    yield* Fiber.join(saving);
    expect((yield* fixture.saved()).file.delegation).toBe("normal");
    expect(fixture.notify.mock.calls.some(([, level]) => level === "error")).toBe(true);
    yield* fixture.settings("global delegation encouraged");
    expect(fixture.notify.mock.calls.filter(([, level]) => level === "error")).toHaveLength(1);
    const saved = (yield* fixture.saved()).file;
    expect(saved.delegation).toBe("encouraged");
    expect(saved.writerWorkspaceMode).toBe("shared-checkout");
    yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
  });

  effectTest("leaves the root prompt unchanged in normal mode", function* () {
    const fixture = yield* setup();
    yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
    const normal = yield* fixture.prompt();
    expect(normal.section).toBeUndefined();
    expect(normal.startGuidelines).toEqual(normal.registeredGuidelines);
    expect(normal.startGuidelines).toContain(NORMAL_START_GUIDELINE);
    yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
  });

  effectTest(
    "applies a session mode on the next run, replacing the default delegation guideline",
    function* () {
      const fixture = yield* setup();
      yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
      for (const mode of ["encouraged", "orchestration"] as const) {
        yield* fixture.settings(`delegation ${mode}`);
        const run = yield* fixture.prompt();
        expect(run.section).toBeDefined();
        expect(run.startGuidelines).toHaveLength(run.registeredGuidelines.length);
        expect(run.startGuidelines).not.toContain(NORMAL_START_GUIDELINE);
      }
      const orchestration = (yield* fixture.prompt()).section;
      yield* fixture.settings("delegation encouraged");
      expect((yield* fixture.prompt()).section).not.toBe(orchestration);

      expect((yield* fixture.prompt(["read"])).section).toBeUndefined();

      yield* fixture.settings("delegation normal");
      expect((yield* fixture.prompt()).section).toBeUndefined();
      yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    },
  );

  effectTest("keeps the session mode across /reload and stops at shutdown", function* () {
    const fixture = yield* setup();
    yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
    yield* fixture.settings("delegation orchestration");
    yield* settle(() =>
      fixture.host.emit("session_shutdown", fixture.ctx, {
        type: "session_shutdown",
        reason: "reload",
      }),
    );
    yield* settle(() =>
      fixture.host.emit("session_start", fixture.ctx, { type: "session_start", reason: "reload" }),
    );
    expect((yield* fixture.prompt()).section).toBeDefined();
    yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    expect((yield* fixture.prompt()).section).toBeUndefined();
  });

  effectTest(
    "shows the profile set and delegation mode as a Pi status without Cosmic UI",
    function* () {
      const fixture = yield* setup();
      yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
      expect(fixture.status()).toContain("review");
      expect(fixture.status()).not.toContain("orchestration");
      yield* fixture.settings("delegation orchestration");
      expect(fixture.status()).toContain("review");
      expect(fixture.status()).toContain("orchestration");
      yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
      expect(fixture.status()).toBeUndefined();
    },
  );

  effectTest("publishes to an active Cosmic UI footer instead of a status", function* () {
    const fixture = yield* setup({ active: true, ready: true, hidden: [] });
    yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
    yield* fixture.settings("delegation encouraged");
    expect(fixture.upserts.at(-1)).toContain("encouraged");
    expect(fixture.status()).toBeUndefined();
    yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    expect(fixture.ownerRemoved()).toBe(true);
  });

  effectTest("respects a hidden footer item in the status fallback", function* () {
    const fixture = yield* setup({ active: false, ready: true, hidden: ["subagents"] });
    yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
    yield* fixture.settings("delegation orchestration");
    expect(fixture.status()).toBeUndefined();
    expect(fixture.upserts).toEqual([]);
    yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
  });
});
