// Test-owned executable fixtures and Promise runners are boundary code.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureClaudeCliReady,
  resetClaudeCliPreflightCache,
} from "../src/boundary/claude-preflight.ts";

let directory: string;

const COUNTER_ENV = "PI_SUBAGENTS_TEST_PREFLIGHT_COUNTER";

const fixture = async (name: string, body: string): Promise<string> => {
  const path = join(directory, name);
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";
if (process.env[${JSON.stringify(COUNTER_ENV)}]) appendFileSync(process.env[${JSON.stringify(COUNTER_ENV)}], "x");
if (process.argv.slice(2).join(" ") !== "auth status --json") process.exit(64);
${body}
`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
};

describe("Claude CLI preflight", () => {
  beforeEach(async () => {
    resetClaudeCliPreflightCache();
    directory = await mkdtemp(join(tmpdir(), "pi-subagents-claude-preflight-"));
    process.env[COUNTER_ENV] = join(directory, "invocations");
  });

  afterEach(async () => {
    resetClaudeCliPreflightCache();
    delete process.env[COUNTER_ENV];
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts an authenticated CLI and caches success per command", async () => {
    const counter = join(directory, "invocations");
    const script = await fixture(
      "fake-claude-auth.mjs",
      `process.stdout.write(JSON.stringify({ loggedIn: true, status: "authenticated" }) + "\\n");`,
    );
    const options = { command: process.execPath, commandArgs: [script] };

    await Effect.runPromise(ensureClaudeCliReady(options));
    await Effect.runPromise(ensureClaudeCliReady(options));

    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it("fails when the CLI reports it is not logged in, without caching the failure", async () => {
    const counter = join(directory, "invocations");
    const script = await fixture(
      "fake-claude-logged-out.mjs",
      `process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");`,
    );
    const options = { command: process.execPath, commandArgs: [script] };

    const error = await Effect.runPromise(Effect.flip(ensureClaudeCliReady(options)));
    expect(error).toMatchObject({
      _tag: "SubagentProcessError",
      operation: "preflight",
      code: "claude_cli_unauthenticated",
    });

    await Effect.runPromise(Effect.flip(ensureClaudeCliReady(options)));
    expect(await readFile(counter, "utf8")).toBe("xx");
  });

  it("distinguishes a failed auth probe from explicit unauthenticated status", async () => {
    const script = await fixture(
      "fake-claude-exit.mjs",
      `process.stderr.write("Not logged in\\n");
process.exit(1);`,
    );

    const error = await Effect.runPromise(
      Effect.flip(ensureClaudeCliReady({ command: process.execPath, commandArgs: [script] })),
    );
    expect(error).toMatchObject({ code: "claude_cli_preflight_failed" });
    expect(error.message).toContain('supports "auth status --json"');
    expect(error.message).toContain("Not logged in");
  });

  it.each([
    ["empty", ``],
    ["malformed", `process.stdout.write("not-json\\n");`],
    ["empty-object", `process.stdout.write("{}\\n");`],
    [
      "ambiguous",
      `process.stdout.write(JSON.stringify({ loggedIn: true, authenticated: false }) + "\\n");`,
    ],
    ["unknown-status", `process.stdout.write(JSON.stringify({ status: "maybe" }) + "\\n");`],
  ])("rejects and does not cache an exit-zero %s auth result", async (_label, body) => {
    const counter = join(directory, "invocations");
    const script = await fixture(`fake-claude-${_label}.mjs`, body);
    const options = { command: process.execPath, commandArgs: [script] };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await Effect.runPromise(Effect.flip(ensureClaudeCliReady(options)));
      expect(error).toMatchObject({ code: "claude_cli_preflight_failed" });
    }
    expect(await readFile(counter, "utf8")).toBe("xx");
  });

  it("deduplicates concurrent probes for the same command", async () => {
    const counter = join(directory, "invocations");
    const script = await fixture(
      "fake-claude-concurrent.mjs",
      `setTimeout(() => {
  process.stdout.write(JSON.stringify({ loggedIn: true, status: "authenticated" }) + "\\n");
}, 100);`,
    );
    const options = { command: process.execPath, commandArgs: [script] };

    await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(ensureClaudeCliReady(options))),
    );

    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it("releases the shared gate when the owning probe is interrupted", async () => {
    const counter = join(directory, "invocations");
    const script = await fixture(
      "fake-claude-interrupt.mjs",
      `import { readFileSync } from "node:fs";
const attempt = readFileSync(process.env[${JSON.stringify(COUNTER_ENV)}], "utf8").length;
if (attempt === 1) setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify({ loggedIn: true, status: "authenticated" }) + "\\n");`,
    );
    const options = { command: process.execPath, commandArgs: [script], timeoutMillis: 2_000 };
    const owner = Effect.runFork(ensureClaudeCliReady(options));
    while (true) {
      const attempts = await readFile(counter, "utf8").catch(() => "");
      if (attempts === "x") break;
      await Effect.runPromise(Effect.sleep("10 millis"));
    }

    const waiter = Effect.runPromise(Effect.flip(ensureClaudeCliReady(options)));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(owner));
    await expect(waiter).resolves.toMatchObject({
      code: "claude_cli_preflight_failed",
      message: expect.stringContaining("owner was interrupted"),
    });
    await Effect.runPromise(ensureClaudeCliReady(options));

    expect(await readFile(counter, "utf8")).toBe("xx");
  });

  it("reports a missing executable distinctly", async () => {
    const error = await Effect.runPromise(
      Effect.flip(ensureClaudeCliReady({ command: join(directory, "missing-claude") })),
    );
    expect(error).toMatchObject({ code: "claude_cli_not_found" });
    expect(error.message).toContain("was not found");
  });

  it("bounds a hung preflight with a timeout", async () => {
    const script = await fixture("fake-claude-hang.mjs", `setInterval(() => {}, 1000);`);

    const error = await Effect.runPromise(
      Effect.flip(
        ensureClaudeCliReady({
          command: process.execPath,
          commandArgs: [script],
          timeoutMillis: 250,
        }),
      ),
    );
    expect(error).toMatchObject({ code: "claude_cli_preflight_failed" });
  });
});
