import assert from "node:assert/strict";
import type { SettingsList } from "@earendil-works/pi-tui";
import { deferredPromise, extensionContextFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewStartupSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewSettingsSubcommand } from "../../src/settings/controller";
import {
  createCodePreviewSettingsModel,
  type SettingsPanelSaveEffects,
} from "../../src/settings/panel";
import { getNativeMcpStatus } from "../../src/tools/native-mcp-registration";
import { effectTest, eventLoopTurn, settle, step } from "../support/effect-test";

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

function commandHarness() {
  let configured = { nativeMcpPreviews: false };
  const writes: Array<{ settings: CodePreviewStartupSettings; signal: AbortSignal | undefined }> =
    [];
  const notices: Array<{ message: string; level: string }> = [];
  const controller = new AbortController();
  const ctx = extensionContextFixture({
    cwd: "/trusted-project",
    mode: "rpc",
    hasUI: true,
    signal: controller.signal,
    isProjectTrusted: () => true,
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  });
  const command = codePreviewSettingsSubcommand({
    loadStartup: () => Promise.resolve({ ...configured }),
    saveStartup: (settings, signal) => {
      writes.push({ settings: { ...settings }, signal });
      configured = { ...settings };
      return Promise.resolve({ ...configured });
    },
  });
  return { command, ctx, writes, notices, configured: () => configured };
}

effectTest("settings discovers and edits the separate global MCP startup option", function* () {
  const h = commandHarness();
  const before = getNativeMcpStatus();
  const completions = h.command.complete?.("native");
  assert.ok(completions?.some((choice) => choice.value === "nativeMcpPreviews"));
  yield* settle(() => h.command.handler("nativeMcpPreviews on", h.ctx));
  assert.deepEqual(h.configured(), { nativeMcpPreviews: true });
  assert.equal(h.writes[0]?.signal, h.ctx.signal);
  yield* settle(() => h.command.handler("global nativeMcpPreviews off", h.ctx));
  assert.deepEqual(h.configured(), { nativeMcpPreviews: false });
  assert.equal(h.writes.length, 2);
  assert.equal(getNativeMcpStatus(), before, "editing never changes the running manager");
  yield* settle(() => h.command.handler("project nativeMcpPreviews on", h.ctx));
  yield* settle(() => h.command.handler("nativeMcpPreviews maybe", h.ctx));
  assert.equal(h.writes.length, 2, "unsupported scopes and values never reach persistence");
});

effectTest(
  "settings status reloads configured startup values independently of running MCP",
  function* () {
    const h = commandHarness();
    yield* settle(() => h.command.handler("nativeMcpPreviews on", h.ctx));
    yield* settle(() => h.command.handler("status", h.ctx));
    assert.ok(h.notices.at(-1)?.message.includes("nativeMcpPreviews = on"));
    yield* settle(() => h.command.handler("nativeMcpPreviews off", h.ctx));
    yield* settle(() => h.command.handler("status", h.ctx));
    assert.ok(h.notices.at(-1)?.message.includes("nativeMcpPreviews = off"));
  },
);

effectTest(
  "retired commands cannot borrow a replacement signal after startup loading",
  function* () {
    const startup = deferredPromise<CodePreviewStartupSettings>();
    const original = new AbortController();
    let signal = original.signal;
    let loadedSignal: AbortSignal | undefined;
    let configured = { nativeMcpPreviews: false };
    const ctx = extensionContextFixture({});
    Object.defineProperty(ctx, "signal", { get: () => signal });
    const command = codePreviewSettingsSubcommand({
      loadStartup: (captured) => {
        loadedSignal = captured;
        return startup.promise;
      },
      saveStartup: (settings) => {
        configured = settings;
        return Promise.resolve(settings);
      },
    });
    const pending = command.handler("nativeMcpPreviews on", ctx);
    assert.equal(loadedSignal, original.signal);
    original.abort();
    signal = new AbortController().signal;
    startup.resolve({ nativeMcpPreviews: false });
    yield* settle(() => pending);
    assert.deepEqual(configured, { nativeMcpPreviews: false });
  },
);

function panelHarness(
  saveStartup: NonNullable<SettingsPanelSaveEffects["queueStartupSave"]>,
  signal?: AbortSignal,
) {
  const ordinary: unknown[] = [];
  const notices: string[] = [];
  let closed = false;
  const finished = deferredPromise();
  const model = createCodePreviewSettingsModel({
    startupSettings: { nativeMcpPreviews: true },
    signal,
    notify: (message) => notices.push(message),
    done: () => {
      closed = true;
      finished.resolve();
    },
    loadOptions: { projectCwd: "/trusted-project", projectTrusted: true },
    effects: {
      queueSave: (settings) => {
        ordinary.push(settings);
        return Promise.resolve();
      },
      initializeSyntax: () => Promise.resolve(),
      queueStartupSave: saveStartup,
    },
  });
  // This owned boundary observes the model's displayed values, without testing Pi layout.
  const values = new Map(model.items.map((item) => [item.id, item.currentValue]));
  const list: SettingsList = opaqueFixture({
    updateValue: (id: string, value: string) => values.set(id, value),
  });
  model.bind(list);
  return {
    model,
    list,
    values,
    ordinary,
    notices,
    closed: () => closed,
    finished: finished.promise,
  };
}

effectTest(
  "the top-level MCP control saves startup only and survives ordinary resets",
  function* () {
    const saved: CodePreviewStartupSettings[] = [];
    const h = panelHarness((settings) => {
      saved.push(settings);
      return Promise.resolve(settings);
    });
    const item = h.model.items.find((entry) => entry.id === "nativeMcpPreviews");
    assert.ok(item && !item.submenu && item.values?.includes("off"));
    h.model.onChange("nativeMcpPreviews", "off", h.list);
    yield* step(eventLoopTurn);
    assert.deepEqual(saved, [{ nativeMcpPreviews: false }]);
    assert.equal(h.ordinary.length, 0);
    assert.equal(h.values.get("nativeMcpPreviews"), "off");
    h.model.onChange("resetToDefaults", "reset now", h.list);
    yield* step(eventLoopTurn);
    assert.equal(h.ordinary.length, 1);
    assert.equal(saved.length, 1);
    assert.equal(h.values.get("nativeMcpPreviews"), "off");
  },
);

effectTest(
  "failed older edits cannot roll back a newer startup draft; latest failures restore committed state",
  function* () {
    const first = deferredPromise<CodePreviewStartupSettings>();
    const second = deferredPromise<CodePreviewStartupSettings>();
    const third = deferredPromise<CodePreviewStartupSettings>();
    const saves = [first, second, third];
    const h = panelHarness(() => saves.shift()!.promise);
    h.model.onChange("nativeMcpPreviews", "off", h.list);
    h.model.onChange("nativeMcpPreviews", "on", h.list);
    first.reject(new Error("first save failed"));
    yield* step(eventLoopTurn);
    assert.equal(h.values.get("nativeMcpPreviews"), "on");
    second.resolve({ nativeMcpPreviews: true });
    yield* step(eventLoopTurn);
    h.model.onChange("nativeMcpPreviews", "off", h.list);
    third.reject(new Error("latest save failed"));
    yield* step(eventLoopTurn);
    assert.equal(h.values.get("nativeMcpPreviews"), "on");
  },
);

effectTest("closing the panel waits for an admitted startup save", function* () {
  const pending = deferredPromise<CodePreviewStartupSettings>();
  const h = panelHarness(() => pending.promise);
  h.model.onChange("nativeMcpPreviews", "off", h.list);
  h.model.onCancel();
  yield* step(eventLoopTurn);
  assert.equal(h.closed(), false);
  pending.resolve({ nativeMcpPreviews: false });
  // The close also joins the real public settings barrier, which does not read user files.
  yield* step(() => h.finished);
  assert.equal(h.closed(), true);
});

effectTest("retired panel callbacks cannot write or publish startup changes", function* () {
  const pending = deferredPromise<CodePreviewStartupSettings>();
  const controller = new AbortController();
  let writes = 0;
  const h = panelHarness(() => {
    writes++;
    return pending.promise;
  }, controller.signal);
  h.model.onChange("nativeMcpPreviews", "off", h.list);
  controller.abort();
  pending.resolve({ nativeMcpPreviews: false });
  yield* step(eventLoopTurn);
  assert.deepEqual(h.notices, []);
  h.model.onChange("nativeMcpPreviews", "on", h.list);
  assert.equal(writes, 1);
});
