// Test-owned executable fixture and Promise runner are boundary code.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import type { ChildLaunchRequest } from "../src/boundary/child-process.ts";
import { acquireClaudeChild } from "../src/boundary/claude-process.ts";

const request: ChildLaunchRequest = {
  runId: "agent-1",
  name: "claude-fixture",
  backend: "claude-cli",
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  model: "sonnet",
  effort: "high",
  activeTools: [],
  projectTrusted: true,
  parentSessionId: "parent",
  systemPrompt: "Supervised child prompt.",
};

describe("Claude process boundary", () => {
  it("rejects untrusted launches before spawning", async () => {
    const error = await Effect.runPromise(
      Effect.flip(acquireClaudeChild({ ...request, projectTrusted: false })),
    );
    expect(error).toMatchObject({
      _tag: "SubagentProcessError",
      operation: "launch",
      message: "Claude Code print mode requires a trusted project.",
    });
  });

  it("surfaces bounded stderr when Claude exits before initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-claude-error-"));
    const fixture = join(directory, "fake-claude-error.mjs");
    await writeFile(
      fixture,
      `process.stderr.write("\\u001b[31munsupported model selector token=secret-value\\u001b[0m\\n");\n`,
      "utf8",
    );
    await chmod(fixture, 0o700);

    try {
      const error = await Effect.runPromise(
        Effect.acquireRelease(
          acquireClaudeChild(request, { command: process.execPath, commandArgs: [fixture] }),
          (handle) => handle.release,
        ).pipe(
          Effect.flatMap((handle) =>
            Effect.flip(handle.send({ type: "get_state", id: "state-error" })),
          ),
          Effect.scoped,
        ),
      );
      expect(error).toMatchObject({ _tag: "SubagentProcessError", operation: "initialize" });
      expect(error.message).toContain("unsupported model selector");
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain("secret-value");
      expect(error.message).not.toContain("\u001b");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a read-only child reports an unexpected tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-claude-policy-"));
    const fixture = join(directory, "fake-claude-policy.mjs");
    await writeFile(
      fixture,
      `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"550e8400-e29b-41d4-a716-446655440000",model:"claude-fixture",tools:["Read","Bash"]})+"\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(fixture, 0o700);

    try {
      const error = await Effect.runPromise(
        Effect.acquireRelease(
          acquireClaudeChild(request, { command: process.execPath, commandArgs: [fixture] }),
          (handle) => handle.release,
        ).pipe(
          Effect.flatMap((handle) =>
            Effect.flip(handle.send({ type: "get_state", id: "state-policy" })),
          ),
          Effect.scoped,
        ),
      );
      expect(error).toMatchObject({
        _tag: "SubagentProcessError",
        operation: "verify Claude tool policy",
      });
      expect(error.message).toContain("Bash");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the first prompt before awaiting initialization and streams subsequent results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-claude-"));
    const fixture = join(directory, "fake-claude.mjs");
    await writeFile(
      fixture,
      `let buffered="";
let initialized=false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  for (;;) {
    const index = buffered.indexOf("\\n");
    if (index < 0) break;
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (!line) continue;
    const value = JSON.parse(line);
    if (value.type !== "user") continue;
    if (!initialized) {
      initialized=true;
      process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"550e8400-e29b-41d4-a716-446655440000",model:"claude-fixture",tools:["Read","Glob","Grep","WebFetch","WebSearch"]})+"\\n");
    }
    process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Fixture complete."}]}})+"\\n");
    process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Fixture complete.",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})+"\\n");
  }
});
`,
      "utf8",
    );
    await chmod(fixture, 0o700);

    try {
      const result = await Effect.runPromise(
        Effect.acquireRelease(
          acquireClaudeChild(request, { command: process.execPath, commandArgs: [fixture] }),
          (handle) => handle.release,
        ).pipe(
          Effect.flatMap((acquired) => {
            const { release: _release, ...handle } = acquired;
            return Effect.gen(function* () {
              const awaitResult = Stream.fromQueue(handle.events).pipe(
                Stream.filter(
                  (event) =>
                    event.type === "claude_message" &&
                    typeof event.value === "object" &&
                    event.value !== null &&
                    "type" in event.value &&
                    event.value.type === "result",
                ),
                Stream.runHead,
              );
              yield* handle.send({ type: "prompt", id: "prompt-1", message: "Review auth." });
              yield* handle.send({ type: "get_state", id: "state-1" });
              const first = yield* awaitResult;
              yield* handle.send({ type: "prompt", id: "prompt-2", message: "Continue." });
              const second = yield* awaitResult;
              return { first, second };
            });
          }),
          Effect.scoped,
        ),
      );
      expect(Option.isSome(result.first)).toBe(true);
      expect(Option.isSome(result.second)).toBe(true);
      if (Option.isSome(result.second))
        expect(result.second.value).toMatchObject({
          type: "claude_message",
          value: { type: "result", result: "Fixture complete." },
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
