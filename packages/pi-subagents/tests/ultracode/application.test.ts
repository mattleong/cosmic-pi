// Promise assertions and Pi host callbacks are test-runner boundaries.
import { tmpdir } from "node:os";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../../src/application/register.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { effectTest, settle, step } from "../support/effect-test.ts";
import { nodeFsPromises, nodePath } from "../support/node-builtins.ts";

type Handler = ExtensionHandler<any, any>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type RegisteredTool = {
  readonly name: string;
  readonly defaultActive?: boolean;
  readonly execute: (
    toolCallId: string,
    params: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ readonly details?: { readonly run?: { readonly id: string } } }>;
};
type SentMessage = { readonly customType: string };
/** The system-prompt options a `before_agent_start` event carries. */
interface PromptOptions {
  readonly promptGuidelines: string[];
  readonly sections: Record<string, string>;
}
/** A field of a Pi lifecycle event this test emits. */
type HostEventField = string | PromptOptions;

const WORKFLOW = "subagent_workflow";
/** Another extension's tool, which ultracode must never remove. */
const FOREIGN = "mcp__docs__search";
const SCRIPT = `export const meta = { name: "noop", description: "Return a value" };\nreturn 1;`;
const SAVED = `export const meta = { name: "review", description: "Review the diff" };\nreturn 1;`;

let nextSession = 1;

/**
 * One Pi session over real Subagents instances: `reload` replaces the instance as Pi does, while
 * the active tools, session id and directories carry over. Workflow notifications reach Pi only
 * while `accepting` is set.
 */
const sessionFixture = (
  options: { readonly projectConfig?: object; readonly trusted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const root = yield* step(() =>
      nodeFsPromises.mkdtemp(nodePath.join(tmpdir(), "pi-subagents-ultracode-")),
    );
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
    let handlers = new Map<string, Handler>();
    let commands = new Map<string, Command>();
    let tools = new Map<string, RegisteredTool>();
    const sent: SentMessage[] = [];
    const userMessages: string[] = [];
    const notify = vi.fn();
    const sessionId = `ultracode-session-${process.pid}-${nextSession++}`;
    const ctx = extensionContextFixture({
      cwd,
      signal: undefined,
      hasUI: true,
      mode: "rpc" as const,
      isIdle: () => idle,
      isProjectTrusted: () => options.trusted ?? true,
      ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    });
    const register = () => {
      handlers = new Map();
      commands = new Map();
      tools = new Map();
      const pi = extensionApiFixture({
        on: vi.fn((name: string, handler: Handler) => {
          handlers.set(name, handler);
        }),
        registerCommand: vi.fn((name: string, definition: { readonly handler: Command }) => {
          commands.set(name, definition.handler);
        }),
        registerTool: vi.fn((tool: RegisteredTool) => {
          tools.set(tool.name, tool);
          if (tool.defaultActive !== false) active = [...new Set([...active, tool.name])];
        }),
        getActiveTools: vi.fn(() => [...active]),
        setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
          active = [...names];
        }),
        sendMessage: vi.fn((message: SentMessage) => {
          if (message.customType === "pi-subagents-workflow" && !accepting)
            throw new Error("Pi is busy");
          sent.push(message);
        }),
        sendUserMessage: vi.fn((message: string) => {
          userMessages.push(message);
        }),
      });
      registerSubagentApplication(pi, {
        getAgentDirectory: () => agentDirectory,
        loadSettings: () => Promise.resolve(),
      });
    };
    const emit = (name: string, event: Readonly<Record<string, HostEventField>> = {}) =>
      settle(() => handlers.get(name)?.({ type: name, ...event }, ctx));
    register();
    yield* emit("session_start", { reason: "startup" });
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
        step(() => commands.get(name)?.(args, ctx) ?? Promise.resolve()),
      /**
       * Starts an agent run from `prompt`, by default the latest request Pi was sent, and returns
       * the ultracode section of its system prompt.
       */
      promptRun: function* (prompt = userMessages.at(-1) ?? "") {
        const sections: Record<string, string> = {};
        yield* emit("before_agent_start", {
          prompt,
          systemPromptOptions: { promptGuidelines: [], sections },
        });
        return sections["subagents_ultracode"];
      },
      startWorkflow: () =>
        step(() =>
          tools
            .get(WORKFLOW)!
            .execute("call-1", { action: "start", script: SCRIPT }, undefined, undefined, ctx),
        ).pipe(Effect.map((result) => result.details?.run?.id ?? "")),
      /** Waits until Pi accepted the run's notification or notice and its record says so. */
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
        yield* emit("session_shutdown", { reason: "reload" });
        register();
        yield* emit("session_start", { reason: "reload" });
      },
      dispose: function* () {
        yield* emit("session_shutdown", { reason: "quit" });
        yield* step(() => nodeFsPromises.rm(root, { recursive: true, force: true }));
      },
    };
  });

describe("ultracode opt-in", () => {
  effectTest("keeps workflows out of the loadout and the prompt by default", function* () {
    const session = yield* sessionFixture();
    try {
      expect(session.workflowActive()).toBe(false);
      expect(yield* session.promptRun()).toBeUndefined();
      expect(session.foreignKept()).toBe(true);
    } finally {
      yield* session.dispose();
    }
  });

  effectTest("turns workflows on and off for the session with /ultracode", function* () {
    const session = yield* sessionFixture();
    try {
      yield* session.command("ultracode", "on");
      expect(session.workflowActive()).toBe(true);
      expect(yield* session.promptRun()).toBeDefined();
      // The session's own value outlives tree navigation and reload.
      yield* session.emit("session_tree");
      expect(session.workflowActive()).toBe(true);
      yield* session.reload();
      expect(session.workflowActive()).toBe(true);

      // Right after the reload the tool leaves when the next agent run starts.
      yield* session.command("ultracode", "off");
      expect(yield* session.promptRun()).toBeUndefined();
      expect(session.workflowActive()).toBe(false);
      expect(session.foreignKept()).toBe(true);
      expect(session.notify).not.toHaveBeenCalledWith(expect.any(String), "error");
    } finally {
      yield* session.dispose();
    }
  });

  effectTest("reports the setting and the saved workflows with bare /ultracode", function* () {
    const session = yield* sessionFixture();
    try {
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
    } finally {
      yield* session.dispose();
    }
  });

  effectTest("never sends a lone switch word as a task, whatever its case", function* () {
    const session = yield* sessionFixture();
    try {
      yield* session.command("ultracode", "On");
      expect(session.workflowActive()).toBe(true);
      yield* session.command("ultracode", "status");
      expect(session.notify).toHaveBeenLastCalledWith(expect.any(String), "info");
      yield* session.command("ultracode", "OFF");
      expect(yield* session.promptRun("hello")).toBeUndefined();
      expect(session.workflowActive()).toBe(false);
      expect(session.userMessages).toEqual([]);
    } finally {
      yield* session.dispose();
    }
  });

  effectTest("turns workflows on with the /subagents settings session scope", function* () {
    const session = yield* sessionFixture();
    try {
      yield* session.command("subagents", "settings session ultracode true");
      expect(session.workflowActive()).toBe(true);
      yield* session.command("subagents", "settings session ultracode inherit");
      expect(yield* session.promptRun("hello")).toBeUndefined();
      expect(session.workflowActive()).toBe(false);
    } finally {
      yield* session.dispose();
    }
  });

  effectTest("follows a trusted project's saved setting", function* () {
    const trusted = yield* sessionFixture({ projectConfig: { version: 6, ultracode: true } });
    const untrusted = yield* sessionFixture({
      projectConfig: { version: 6, ultracode: true },
      trusted: false,
    });
    try {
      expect(trusted.workflowActive()).toBe(true);
      expect(untrusted.workflowActive()).toBe(false);
    } finally {
      yield* trusted.dispose();
      yield* untrusted.dispose();
    }
  });
});

describe("one-off /ultracode requests", () => {
  effectTest("sends the task with the opt-in note and a budget", function* () {
    const session = yield* sessionFixture();
    try {
      yield* session.command("ultracode", "+500k review the parser");
      expect(session.userMessages).toHaveLength(1);
      expect(session.userMessages[0]?.startsWith("review the parser")).toBe(true);
      expect(session.userMessages[0]).toContain("budget: 500000");
      expect(session.workflowActive()).toBe(true);
      // Text after on or off is a task too, not the session switch.
      yield* session.command("ultracode", "on the parser");
      expect(session.userMessages[1]?.startsWith("on the parser")).toBe(true);
      yield* session.command("ultracode", "+500k");
      expect(session.userMessages).toHaveLength(2);
      expect(session.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    } finally {
      yield* session.dispose();
    }
  });

  effectTest(
    "keeps workflows through the request, its run and the notification's turn",
    function* () {
      const session = yield* sessionFixture();
      try {
        session.setAccepting(false);
        yield* session.command("ultracode", "review the parser");
        expect(yield* session.promptRun()).toBeDefined();
        const runId = yield* session.startWorkflow();
        expect(runId).not.toBe("");
        yield* session.emit("agent_settled");
        // Pi hasn't accepted the run's notification, so the run still needs the main agent.
        expect(session.workflowActive()).toBe(true);

        session.setAccepting(true);
        yield* session.runClosed(runId);
        expect(session.sent).toEqual([
          expect.objectContaining({ customType: "pi-subagents-workflow" }),
        ]);
        expect(session.workflowActive()).toBe(true);
        yield* session.emit("agent_settled");
        expect(session.workflowActive()).toBe(false);
        expect(session.foreignKept()).toBe(true);
      } finally {
        yield* session.dispose();
      }
    },
  );

  effectTest("reopens after a reload so an interrupted run can be resumed", function* () {
    const session = yield* sessionFixture();
    try {
      session.setAccepting(false);
      yield* session.command("ultracode", "review the parser");
      yield* session.promptRun();
      const runId = yield* session.startWorkflow();
      yield* session.emit("agent_settled");

      yield* session.reload();
      // The reload interrupted delivery; the new instance's notice reaches Pi once it accepts.
      session.setAccepting(true);
      yield* session.runClosed(runId);
      expect(session.sent).toEqual([
        expect.objectContaining({ customType: "pi-subagents-workflow" }),
      ]);
      expect(session.workflowActive()).toBe(true);
      expect(yield* session.promptRun("resume it")).toBeDefined();
      yield* session.emit("agent_settled");
      expect(session.workflowActive()).toBe(false);
    } finally {
      yield* session.dispose();
    }
  });
});
