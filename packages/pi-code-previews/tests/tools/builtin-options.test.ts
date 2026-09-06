// Explicit test entry-point Effects drive real settings files and env boundaries.
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { cleanupTestTempDirectories, createTestTempDirectory } from "../support/temp-directories";
import { getBuiltinToolOptions } from "../../src/tools/builtin-options";
import { effectTest, step } from "../support/effect-test";

// Raw Node builtin access for test scaffolding, mirroring pi-cosmic-core's platform boundary.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdir, writeFile } = nodeFsModule.promises;
const { join } = nodePathModule;

// Mutating the agent-directory slot is this suite's process-environment host boundary.
const processEnv: NodeJS.ProcessEnv = process.env;

const originalPiCodingAgentDir = processEnv.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalPiCodingAgentDir === undefined) delete processEnv.PI_CODING_AGENT_DIR;
  else processEnv.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  return cleanupTestTempDirectories();
});

effectTest(
  "builtin tool options ignore project settings when the project is untrusted",
  function* () {
    const root = yield* step(() => createTestTempDirectory("pi-code-previews-tool-options-trust-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    processEnv.PI_CODING_AGENT_DIR = agentDir;
    yield* step(() => mkdir(agentDir, { recursive: true }));
    yield* step(() => mkdir(join(cwd, ".pi"), { recursive: true }));
    yield* step(() =>
      writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          shellCommandPrefix: "export PI_GLOBAL_PREFIX=ok;",
          shellPath: "/bin/sh",
          images: { autoResize: false },
        }),
        "utf8",
      ),
    );
    yield* step(() =>
      writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          shellCommandPrefix: "malicious-project-prefix",
          shellPath: "/tmp/malicious-project-shell",
          images: { autoResize: true },
        }),
        "utf8",
      ),
    );

    const untrusted = getBuiltinToolOptions(cwd, false);
    assert.equal(untrusted.bash?.commandPrefix, "export PI_GLOBAL_PREFIX=ok;");
    assert.equal(untrusted.bash?.shellPath, "/bin/sh");
    assert.equal(untrusted.read?.autoResizeImages, false);

    const trusted = getBuiltinToolOptions(cwd, true);
    assert.equal(trusted.bash?.commandPrefix, "malicious-project-prefix");
    assert.equal(trusted.bash?.shellPath, "/tmp/malicious-project-shell");
    assert.equal(trusted.read?.autoResizeImages, true);
  },
);
