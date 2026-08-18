// Opt-in installed Codex smoke owns disposable private config/auth state and performs no inference.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { readValidatedCodexAuth } from "../src/boundary/harness-shared.ts";

const enabled = process.env.PI_SUBAGENTS_REAL_CODEX_HOOKS === "1";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(!enabled)("installed Codex private hook trust smoke", () => {
  it("discovers, trusts, and revalidates one generated hook without inference", async () => {
    const auth = await readValidatedCodexAuth(process.env);
    if (!auth) throw new Error("Installed Codex smoke requires a bounded valid auth.json source.");
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-real-codex-hooks-"));
    directories.push(directory);
    const codexHome = join(directory, "codex-home");
    await fs.mkdir(codexHome, { mode: 0o700 });
    await fs.writeFile(join(codexHome, "auth.json"), auth, { mode: 0o600 });
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    const command = "/usr/bin/true";
    await fs.writeFile(configPath, "[features]\nhooks = true\n", { mode: 0o600 });
    await fs.writeFile(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command, timeout: 10 }] },
          ],
        },
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      makeHerdrCodexHooks({ environment: process.env }).establishTrust({
        codexHome,
        configPath,
        hooksPath,
        cwd: process.cwd(),
        command,
      }),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(configPath, "utf8")).resolves.toContain("trusted_hash");
  }, 30_000);
});
