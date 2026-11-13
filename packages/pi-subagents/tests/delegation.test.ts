import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  recordingExtensionHost,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import {
  COSMIC_UI_HOST_QUERY,
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
import { effectTest, eventLoopTurn, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Fn from "effect/Function";

const agentDirectoryWithProfileSet = function* (name: string, delegation?: DelegationMode) {
  const directory = yield* temporaryDirectory("pi-subagents-delegation-");
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

const setup = function* (
  cosmicUi?: CosmicUiHostState,
  delegation?: DelegationMode,
  projectTrusted = false,
) {
  const agentDirectory = yield* agentDirectoryWithProfileSet("review", delegation);
  const events = createEventBus();
  if (cosmicUi)
    events.on(COSMIC_UI_HOST_QUERY, (data) => normalizeCosmicUiHostQuery(data)?.respond(cosmicUi));
  const host = recordingExtensionHost({}, { events });
  registerSubagentApplication(host.pi, {
    getAgentDirectory: () => agentDirectory,
    loadSettings: () => Promise.resolve(),
  });
  const notify = vi.fn();
  const surface = fakeCustomSurfaceHost();
  let nextMount = deferredPromise();
  const ctx = sessionContextFixture(
    {
      mode: "tui",
      hasUI: true,
      // A trusted project reads its settings from the temporary directory, never the checkout.
      ...(projectTrusted && { cwd: agentDirectory }),
      isProjectTrusted: () => projectTrusted,
      ui: {
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
  const prompt = function* (selectedTools = ["read", "agent_start"]) {
    const startGuidelines = host.tools.get("agent_start")?.promptGuidelines ?? [];
    const event = beforeAgentStartEvent("Do the work", {
      selectedTools,
      toolGuidelines: { agent_start: [...startGuidelines] },
    });
    yield* settle(() => host.emit("before_agent_start", ctx, event));
    return {
      section: event.systemPromptOptions.sections[DELEGATION_PROMPT_SECTION],
      startGuidelines: event.systemPromptOptions.toolGuidelines.agent_start ?? [],
      registeredGuidelines: startGuidelines,
    };
  };
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

const openGlobalDelegation = function* (fixture: {
  readonly settings: (args: string) => Effect.Effect<unknown>;
  readonly surface: ReturnType<typeof fakeCustomSurfaceHost>;
  readonly mounted: () => Promise<void>;
}) {
  const mounted = fixture.mounted();
  const picker = yield* fixture.settings("").pipe(Effect.forkScoped);
  yield* step(() => mounted);
  // Writer workspace, then the Session and Global groups; Global opens on its delegation row.
  for (const key of ["j", "j", "\r"]) fixture.surface.editor?.handleInput?.(key);
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
      // Each choice opens the row's list, which starts on the current value, and picks another.
      const choose = (moves: ReadonlyArray<string>) => {
        for (const key of ["\r", ...moves, "\r"]) fixture.surface.editor?.handleInput?.(key);
      };
      choose(["j"]); // orchestration
      yield* step(gate.wait);
      choose(["j"]); // inherit
      choose(["k", "k", "k"]); // normal
      choose(["j"]); // encouraged
      const nesting = yield* fixture.settings("global maxDepth 3").pipe(Effect.forkScoped);
      gate.release();
      yield* Fiber.join(nesting);
      const saved = yield* fixture.saved();
      expect(saved.file.delegation).toBe("encouraged");
      expect(saved.file.nesting?.maxDepth).toBe(3);
      expect(Arr.filter(fixture.notify.mock.calls, ([, level]) => level !== "info")).toEqual([]);
      // Back out of the Global group, then close the settings.
      fixture.surface.editor?.handleInput?.("\u001b");
      fixture.surface.editor?.handleInput?.("\u001b");
      yield* Fiber.join(picker);
      yield* settle(() => fixture.host.emit("session_shutdown", fixture.ctx));
    },
  );

  effectTest(
    "puts back the open project group's inherited delegation when a global save fails",
    function* () {
      const gate = yield* pauseNextDelegationSave();
      const fixture = yield* setup(undefined, undefined, true);
      yield* settle(() => fixture.host.emit("session_start", fixture.ctx));
      const input = (...keys: ReadonlyArray<string>) => {
        for (const key of keys) fixture.surface.editor?.handleInput?.(key);
      };
      const lines = () => fixture.surface.editor?.render(120) ?? [];
      const find = (matches: (entry: string) => boolean) =>
        Option.getOrElse(Arr.findFirst(lines(), matches), () => "");
      // The Delegation row, not the group description that also starts with the word.
      const delegationRow = () => find((entry) => /^\s*›?\s*Delegation\s{2}/u.test(entry));
      const marked = () => find((entry) => Fn.pipe(entry, Str.includes("(•)")));
      const cursor = () => find((entry) => /^\s*›/u.test(entry));
      const picker = yield* openGlobalDelegation(fixture);
      // Its list leads with `inherit (normal)`, then normal, encouraged, and orchestration.
      input("\r", "j", "j", "j", "\r");
      yield* step(gate.wait);
      // Back to the scopes, then Project, whose delegation inherits Global's chosen mode.
      input("\u001b", "j", "\r");
      expect(delegationRow()).toContain("inherit (orchestration)");
      input("\r");
      expect(cursor()).toContain("inherit (orchestration)");
      // Another writer changes the document, so Global's save fails and is put back.
      yield* step(() =>
        nodeFsPromises.writeFile(
          nodePath.join(fixture.agentDirectory, "pi-subagents.json"),
          JSON.stringify({ version: 6, writerWorkspaceMode: "shared-checkout" }),
        ),
      );
      gate.release();
      for (const _ of Arr.range(1, 200)) {
        if (Arr.some(fixture.notify.mock.calls, ([, level]) => level === "error")) break;
        yield* step(eventLoopTurn);
      }
      expect(Arr.some(fixture.notify.mock.calls, ([, level]) => level === "error")).toBe(true);
      expect(marked()).toContain("inherit (normal)");
      expect(cursor()).toContain("inherit (normal)");
      input("\u001b");
      expect(delegationRow()).toContain("inherit (normal)");
      input("\u001b", "\u001b");
      yield* Fiber.join(picker);
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
    expect(Arr.some(fixture.notify.mock.calls, ([, level]) => level === "error")).toBe(true);
    yield* fixture.settings("global delegation encouraged");
    expect(Arr.filter(fixture.notify.mock.calls, ([, level]) => level === "error")).toHaveLength(1);
    const saved = (yield* fixture.saved()).file;
    expect(saved.delegation).toBe("encouraged");
    expect(saved.writerWorkspaceMode).toBe("shared-checkout");
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
});
