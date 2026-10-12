import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  extensionApiFixture,
  recordingExtensionHost,
  temporaryDirectory,
  type DefaultedEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../../src/application/register.ts";
import { beforeAgentStartEvent, sessionContextFixture } from "../fixtures/pi-host.ts";
import { effectTest, settle, step } from "../support/effect-test.ts";
import { nodeFsPromises, nodePath } from "../support/node-builtins.ts";

const decodeRunId = Schema.decodeUnknownOption(
  Schema.Struct({ details: Schema.Struct({ run: Schema.Struct({ id: Schema.String }) }) }),
);

const WORKFLOW = "subagent_workflow";
const FOREIGN = "mcp__docs__search";
const SCRIPT = `export const meta = { name: "noop", description: "Return a value" };\nreturn 1;`;
const SAVED = `export const meta = { name: "review", description: "Review the diff" };\nreturn 1;`;

let nextSession = 1;

const sessionFixture = (
  options: { readonly projectConfig?: object; readonly trusted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("pi-subagents-ultracode-");
    const agentDirectory = nodePath.join(root, "agent");
    const cwd = nodePath.join(root, "project");
    yield* step(() => nodeFsPromises.mkdir(nodePath.join(cwd, ".pi"), { recursive: true }));
    yield* step(() =>
      nodeFsPromises.mkdir(nodePath.join(agentDirectory, "workflows"), { recursive: true }),
    );
    yield* step(() =>
      nodeFsPromises.writeFile(nodePath.join(agentDirectory, "workflows", "review.js"), SAVED),
    );
    if (options.projectConfig)
      yield* step(() =>
        nodeFsPromises.writeFile(
          nodePath.join(cwd, ".pi", "pi-subagents.json"),
          JSON.stringify(options.projectConfig),
        ),
      );
    let active: ReadonlyArray<string> = ["read", FOREIGN];
    let accepting = true;
    let idle = true;
    let host = recordingExtensionHost();
    const sent: string[] = [];
    const userMessages: string[] = [];
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    const sessionId = `ultracode-session-${process.pid}-${nextSession++}`;
    const ctx = sessionContextFixture(
      {
        cwd,
        hasUI: true,
        isIdle: () => idle,
        isProjectTrusted: () => options.trusted ?? true,
        ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
      },
      sessionId,
    );
    const register = () => {
      host = recordingExtensionHost();
      const recorded = host.pi;
      const pi = extensionApiFixture({
        ...recorded,
        registerTool: (tool) => {
          recorded.registerTool(tool);
          if (tool.defaultActive !== false) active = [...new Set([...active, tool.name])];
        },
        getActiveTools: () => [...active],
        setActiveTools: (names) => {
          active = [...names];
        },
        sendMessage: (message) => {
          if (message.customType === "pi-subagents-workflow" && !accepting)
            throw new Error("Pi is busy");
          sent.push(message.customType);
        },
        sendUserMessage: (message) => {
          if (Predicate.isString(message)) userMessages.push(message);
        },
      });
      registerSubagentApplication(pi, {
        getAgentDirectory: () => agentDirectory,
        loadSettings: () => Promise.resolve(),
      });
    };
    const emit = <Name extends DefaultedEventName>(name: Name, event?: ExtensionEventNamed<Name>) =>
      settle(() => host.emit(name, ctx, event));
    register();
    yield* Effect.addFinalizer(() =>
      emit("session_shutdown", { type: "session_shutdown", reason: "quit" }),
    );
    yield* emit("session_start", { type: "session_start", reason: "startup" });
    return {
      ctx,
      notify,
      userMessages,
      sent,
      emit,
      workflowActive: () => active.includes(WORKFLOW),
      foreignKept: () => active.includes(FOREIGN),
      setAccepting: (value: boolean) => {
        accepting = value;
      },
      setIdle: (value: boolean) => {
        idle = value;
      },
      command: (name: string, args: string) =>
        step(() => host.commands.get(name)?.handler(args, ctx) ?? Promise.resolve()),
      promptRun: function* (prompt = userMessages.at(-1) ?? "") {
        const sections: Record<string, string> = {};
        yield* settle(() =>
          host.emit("before_agent_start", ctx, beforeAgentStartEvent(prompt, { sections })),
        );
        return sections["subagents_ultracode"];
      },
      startWorkflow: () =>
        step(() => {
          const tool = host.tools.get(WORKFLOW);
          if (!tool) throw new Error(`Missing tool ${WORKFLOW}`);
          return tool.execute(
            "call-1",
            { action: "start", script: SCRIPT },
            undefined,
            undefined,
            ctx,
          );
        }).pipe(
          Effect.map((result) =>
            Option.match(decodeRunId(result), {
              onNone: () => "",
              onSome: (decoded) => decoded.details.run.id,
            }),
          ),
        ),
      runClosed: (runId: string) =>
        step(() =>
          vi.waitFor(
            () =>
              nodeFsPromises
                .readFile(
                  nodePath.join(agentDirectory, "subagents", "workflow-runs", runId, "run.json"),
                  "utf8",
                )
                .then((text) => expect(JSON.parse(text)).toMatchObject({ notified: true })),
            { timeout: 15_000, interval: 20 },
          ),
        ),
      reload: function* () {
        yield* emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
        register();
        yield* emit("session_start", { type: "session_start", reason: "reload" });
      },
    };
  });

describe("ultracode opt-in", () => {
  effectTest("keeps workflows out of the loadout and the prompt by default", function* () {
    const session = yield* sessionFixture();
    expect(session.workflowActive()).toBe(false);
    expect(yield* session.promptRun()).toBeUndefined();
    expect(session.foreignKept()).toBe(true);
  });

  effectTest("turns workflows on and off for the session with /ultracode", function* () {
    const session = yield* sessionFixture();
    yield* session.command("ultracode", "on");
    expect(session.workflowActive()).toBe(true);
    expect(yield* session.promptRun()).toBeDefined();
    yield* session.emit("session_tree");
    expect(session.workflowActive()).toBe(true);
    yield* session.reload();
    expect(session.workflowActive()).toBe(true);

    yield* session.command("ultracode", "off");
    expect(yield* session.promptRun()).toBeUndefined();
    expect(session.workflowActive()).toBe(false);
    expect(session.foreignKept()).toBe(true);
    expect(session.notify).not.toHaveBeenCalledWith(expect.any(String), "error");
  });

  effectTest("reports the setting and the saved workflows with bare /ultracode", function* () {
    const session = yield* sessionFixture();
    const report = function* () {
      yield* session.command("ultracode", "");
      const [text, level] = session.notify.mock.lastCall ?? [];
      expect(level).toBe("info");
      return String(text);
    };
    const off = yield* report();
    expect(off).toContain("review");
    yield* session.command("ultracode", "on");
    expect(yield* report()).not.toBe(off);
    expect(session.userMessages).toEqual([]);
  });

  effectTest("never sends a lone switch word as a task, whatever its case", function* () {
    const session = yield* sessionFixture();
    yield* session.command("ultracode", "On");
    expect(session.workflowActive()).toBe(true);
    yield* session.command("ultracode", "status");
    expect(session.notify).toHaveBeenLastCalledWith(expect.any(String), "info");
    yield* session.command("ultracode", "OFF");
    expect(yield* session.promptRun("hello")).toBeUndefined();
    expect(session.workflowActive()).toBe(false);
    expect(session.userMessages).toEqual([]);
  });

  effectTest("turns workflows on with the /subagents settings session scope", function* () {
    const session = yield* sessionFixture();
    yield* session.command("subagents", "settings session ultracode true");
    expect(session.workflowActive()).toBe(true);
    yield* session.command("subagents", "settings session ultracode inherit");
    expect(yield* session.promptRun("hello")).toBeUndefined();
    expect(session.workflowActive()).toBe(false);
  });

  effectTest("follows a trusted project's saved setting", function* () {
    const trusted = yield* sessionFixture({ projectConfig: { version: 6, ultracode: true } });
    const untrusted = yield* sessionFixture({
      projectConfig: { version: 6, ultracode: true },
      trusted: false,
    });
    expect(trusted.workflowActive()).toBe(true);
    expect(untrusted.workflowActive()).toBe(false);
  });
});

describe("one-off /ultracode requests", () => {
  effectTest("sends the task with the opt-in note and a budget", function* () {
    const session = yield* sessionFixture();
    yield* session.command("ultracode", "+500k review the parser");
    expect(session.userMessages).toHaveLength(1);
    expect(session.userMessages[0]?.startsWith("review the parser")).toBe(true);
    expect(session.userMessages[0]).toContain("budget: 500000");
    expect(session.workflowActive()).toBe(true);
    yield* session.command("ultracode", "on the parser");
    expect(session.userMessages[1]?.startsWith("on the parser")).toBe(true);
    yield* session.command("ultracode", "+500k");
    expect(session.userMessages).toHaveLength(2);
    expect(session.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
  });

  effectTest(
    "keeps workflows through the request, its run and the notification's turn",
    function* () {
      const session = yield* sessionFixture();
      session.setAccepting(false);
      yield* session.command("ultracode", "review the parser");
      expect(yield* session.promptRun()).toBeDefined();
      const runId = yield* session.startWorkflow();
      expect(runId).not.toBe("");
      yield* session.emit("agent_settled");
      expect(session.workflowActive()).toBe(true);

      session.setAccepting(true);
      yield* session.runClosed(runId);
      expect(session.sent).toEqual(["pi-subagents-workflow"]);
      expect(session.workflowActive()).toBe(true);
      yield* session.emit("agent_settled");
      expect(session.workflowActive()).toBe(false);
      expect(session.foreignKept()).toBe(true);
    },
  );

  effectTest("reopens after a reload so an interrupted run can be resumed", function* () {
    const session = yield* sessionFixture();
    session.setAccepting(false);
    yield* session.command("ultracode", "review the parser");
    yield* session.promptRun();
    const runId = yield* session.startWorkflow();
    yield* session.emit("agent_settled");

    yield* session.reload();
    session.setAccepting(true);
    yield* session.runClosed(runId);
    expect(session.sent).toEqual(["pi-subagents-workflow"]);
    expect(session.workflowActive()).toBe(true);
    expect(yield* session.promptRun("resume it")).toBeDefined();
    yield* session.emit("agent_settled");
    expect(session.workflowActive()).toBe(false);
  });
});
