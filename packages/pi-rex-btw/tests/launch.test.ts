import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import {
  childCommand,
  parseParentReference,
  promptProblem,
  rexLocation,
  type ChildLaunch,
} from "../src/launch.ts";

const PARENT = { id: "019fd4cd-4c88-7564-8b67-3b917b42df51", path: "/sessions/parent.jsonl" };

const launch = (overrides: Partial<ChildLaunch> = {}): ChildLaunch => ({
  cwd: "/projects/demo",
  branch: undefined,
  extensionPath: "/extensions/pi-rex-btw/",
  shell: "/bin/zsh",
  prompt: undefined,
  model: undefined,
  thinkingLevel: undefined,
  parent: undefined,
  ...overrides,
});

const piArgs = (command: ReturnType<typeof childCommand>) =>
  command.argv.slice(command.argv.indexOf("pi"));

describe("child command", () => {
  it("runs Pi through an interactive POSIX shell without reparsing arguments", () => {
    const command = childCommand(launch({ prompt: '$(touch /tmp/x); "quoted" & exit' }));
    expect(command.startsShell).toBe(true);
    expect(command.argv.slice(0, 4)).toEqual(["/bin/zsh", "-i", "-c", 'exec "$0" "$@"']);
    expect(command.argv.at(-1)).toBe('$(touch /tmp/x); "quoted" & exit');
  });

  it("lets Rex start Pi when the shell can't take positional arguments", () => {
    for (const shell of ["/opt/homebrew/bin/fish", "zsh", undefined]) {
      const command = childCommand(launch({ shell }));
      expect(command.startsShell).toBe(false);
      expect(command.argv[0]).toBe("pi");
    }
  });

  it("starts an unsaved session with the inherited model, thinking level, and parent", () => {
    const args = piArgs(
      childCommand(
        launch({
          model: { provider: "anthropic", id: "claude-opus-5-5" },
          thinkingLevel: "high",
          parent: PARENT,
        }),
      ),
    );
    expect(args).toContain("--no-session");
    expect(Arr.join(args, " ")).toContain("-e /extensions/pi-rex-btw/");
    expect(Arr.join(args, " ")).toContain("--provider anthropic --model claude-opus-5-5");
    expect(Arr.join(args, " ")).toContain("--thinking high");
    expect(args).toContain(`--rex-btw-parent=${PARENT.id}`);
    expect(args).toContain(`--rex-btw-parent-file=${PARENT.path}`);
    expect(args).not.toContain("--");
  });

  it("passes prompts that look like options or file attachments as messages", () => {
    const dash = piArgs(childCommand(launch({ prompt: "--help me" })));
    expect(dash.slice(-2)).toEqual(["--", "--help me"]);
    const at = piArgs(childCommand(launch({ prompt: "@src/app.ts explain" })));
    const message = at.at(-1) ?? "";
    expect(Str.trim(message)).toBe("@src/app.ts explain");
    expect(Str.startsWith("@")(message)).toBe(false);
  });
});

describe("display name", () => {
  it("names the pane after the branch and directory", () => {
    const name = (branch?: string) => {
      const args = piArgs(childCommand(launch({ branch })));
      return args[args.indexOf("--name") + 1];
    };
    expect(name("feature/rex")).toBe("[BTW] - feature/rex - demo");
    expect(name()).toBe("[BTW] - demo");
  });
});

describe("input admission", () => {
  it("rejects prompts that can't be passed as an argument", () => {
    expect(promptProblem("fine")).toBeUndefined();
    expect(promptProblem("a\0b")).toBeDefined();
    expect(promptProblem(Str.repeat(70 * 1024)("x"))).toBeDefined();
  });

  it("accepts only absolute, single-line parent files with a session ID", () => {
    expect(parseParentReference(PARENT.id, PARENT.path)).toEqual(PARENT);
    expect(parseParentReference(PARENT.id, "relative.jsonl")).toBeUndefined();
    expect(parseParentReference(PARENT.id, "/a\nb.jsonl")).toBeUndefined();
    expect(parseParentReference(PARENT.id, undefined)).toBeUndefined();
    expect(parseParentReference(true, PARENT.path)).toBeUndefined();
  });

  it("requires both Rex session and pane identifiers", () => {
    expect(rexLocation({ REX_SESSION: "session:a", REX_BLOCK: "block:b" })).toEqual({
      sessionId: "session:a",
      blockId: "block:b",
    });
    expect(rexLocation({ REX_SESSION: "session:a" })).toBeUndefined();
    expect(rexLocation({ REX_SESSION: "", REX_BLOCK: "block:b" })).toBeUndefined();
  });
});
