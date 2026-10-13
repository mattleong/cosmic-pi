import { tmpdir } from "node:os";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
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
import { DELEGATION_PROMPT_SECTION, NORMAL_START_GUIDELINE } from "../src/delegation/prompt.ts";
import { beforeAgentStartEvent, sessionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const STATUS_KEY = "pi-subagents.session";

const agentDirectoryWithProfileSet = function* (name: string) {
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
        defaultProfileSet: name,
        profileSets: { [name]: { profiles: {} } },
      }),
    ),
  );
  return directory;
};

const setup = function* (cosmicUi?: CosmicUiHostState) {
  const agentDirectory = yield* agentDirectoryWithProfileSet("review");
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
  const ctx = sessionContextFixture(
    { mode: "tui", hasUI: true, isProjectTrusted: () => false, ui: { setStatus } },
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
    settings,
    prompt,
    status,
    upserts,
    ownerRemoved: () => ownerRemoved,
  };
};

describe("delegation mode", () => {
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
