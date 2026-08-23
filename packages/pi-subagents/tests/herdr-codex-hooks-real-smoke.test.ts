// Opt-in installed Codex smoke owns disposable private config/auth state and performs no inference.
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { readValidatedCodexAuth } from "../src/boundary/harness-shared.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;

const smokeGateEnabled = (source: NodeJS.ProcessEnv): boolean =>
  source.PI_SUBAGENTS_REAL_CODEX_HOOKS === "1";
const enabled = smokeGateEnabled(process.env);
const directories: string[] = [];

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe.skipIf(!enabled)("installed Codex private hook trust smoke", () => {
  it("discovers, trusts, and revalidates one generated hook without inference", () => {
    return readValidatedCodexAuth(process.env).then((auth) => {
      if (!auth)
        throw new Error("Installed Codex smoke requires a bounded valid auth.json source.");
      return fs.mkdtemp(join(tmpdir(), "pi-subagents-real-codex-hooks-")).then((directory) => {
        directories.push(directory);
        const codexHome = join(directory, "codex-home");
        const configPath = join(codexHome, "config.toml");
        const hooksPath = join(codexHome, "hooks.json");
        const command = "/usr/bin/true";
        return fs
          .mkdir(codexHome, { mode: 0o700 })
          .then(() => fs.writeFile(join(codexHome, "auth.json"), auth, { mode: 0o600 }))
          .then(() => fs.writeFile(configPath, "[features]\nhooks = true\n", { mode: 0o600 }))
          .then(() =>
            fs.writeFile(
              hooksPath,
              `${JSON.stringify({
                hooks: {
                  SessionStart: [
                    { matcher: "startup", hooks: [{ type: "command", command, timeout: 10 }] },
                  ],
                },
              })}\n`,
              { mode: 0o600 },
            ),
          )
          .then(() =>
            expect(
              makeHerdrCodexHooks({ environment: process.env }).establishTrust({
                codexHome,
                configPath,
                hooksPath,
                cwd: process.cwd(),
                command,
              }),
            ).resolves.toBeUndefined(),
          )
          .then(() => expect(fs.readFile(configPath, "utf8")).resolves.toContain("trusted_hash"));
      });
    });
  }, 30_000);
});
