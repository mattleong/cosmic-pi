// Effect test entry point owns the temporary guidance fixtures.
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import {
  loadAdvisorInstructionsEffect,
  MAX_INSTRUCTION_BYTES,
} from "../src/review/instructions.ts";

const tempAgentFixture = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix });
    const agentDir = path.join(directory, "agent");
    const configPath = path.join(agentDir, "extensions", "pi-advisor.json");
    return { agentDir, configPath, directory, fs, path };
  });

layer(advisorPlatformLayer)("advisor instructions", (it) => {
  describe("advisor instructions", () => {
    it.effect("loads global guidance before trusted project guidance", () =>
      Effect.gen(function* () {
        const { agentDir, configPath, directory, fs, path } = yield* tempAgentFixture(
          "pi-advisor-instructions-",
        );
        const projectDir = path.join(directory, "project");
        yield* fs.makeDirectory(path.join(projectDir, ".pi"), { recursive: true });
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* fs.writeFileString(path.join(agentDir, "ADVISOR.md"), "Watch global invariants.");
        yield* fs.writeFileString(
          path.join(projectDir, ".pi", "ADVISOR.md"),
          "Watch the project queue.",
        );

        const loaded = yield* loadAdvisorInstructionsEffect(configPath, projectDir, true);

        expect(loaded.paths).toEqual([
          path.join(agentDir, "ADVISOR.md"),
          path.join(projectDir, ".pi", "ADVISOR.md"),
        ]);
        expect(loaded.content).toContain("Watch global invariants.");
        expect(loaded.content).toContain("Watch the project queue.");
        expect(loaded.content?.indexOf("global")).toBeLessThan(
          loaded.content?.indexOf("project") ?? 0,
        );
      }),
    );

    it.effect("does not load project guidance for an untrusted project", () =>
      Effect.gen(function* () {
        const { configPath, directory, fs, path } = yield* tempAgentFixture(
          "pi-advisor-instructions-",
        );
        const projectDir = path.join(directory, "project");
        yield* fs.makeDirectory(path.join(projectDir, ".pi"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, ".pi", "ADVISOR.md"),
          "Untrusted guidance.",
        );

        expect(yield* loadAdvisorInstructionsEffect(configPath, projectDir, false)).toEqual({
          paths: [],
        });
      }),
    );

    it.effect("bounds production guidance reads by bytes before decoding", () =>
      Effect.gen(function* () {
        const { agentDir, configPath, directory, fs, path } = yield* tempAgentFixture(
          "pi-advisor-instructions-",
        );
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(agentDir, "ADVISOR.md"),
          "é".repeat(MAX_INSTRUCTION_BYTES),
        );

        const loaded = yield* loadAdvisorInstructionsEffect(configPath, directory, false);
        expect(loaded.content).toContain("[Advisor guidance truncated]");
        expect(loaded.content?.length).toBeLessThan(40_000);
      }),
    );

    it.effect("rejects symlink and FIFO guidance without blocking", () =>
      Effect.gen(function* () {
        const { agentDir, configPath, directory, fs, path } = yield* tempAgentFixture(
          "pi-advisor-instructions-special-",
        );
        yield* fs.makeDirectory(agentDir, { recursive: true });
        const outside = path.join(directory, "outside.md");
        yield* fs.writeFileString(outside, "outside guidance");
        yield* fs.symlink(outside, path.join(agentDir, "ADVISOR.md"));
        expect(yield* loadAdvisorInstructionsEffect(configPath, directory, false)).toEqual({
          paths: [],
        });
        yield* fs.remove(path.join(agentDir, "ADVISOR.md"));
        if (process.platform !== "win32") {
          const mkfifo = yield* runBoundedProcessNode({
            executable: "mkfifo",
            args: [path.join(agentDir, "ADVISOR.md")],
            stdoutLimitBytes: 4_096,
            stderrLimitBytes: 4_096,
            timeoutMillis: 5_000,
          });
          expect(mkfifo.code).toBe(0);
          const started = performance.now();
          expect(yield* loadAdvisorInstructionsEffect(configPath, directory, false)).toEqual({
            paths: [],
          });
          expect(performance.now() - started).toBeLessThan(1_000);
        }
      }),
    );

    it.effect("ignores missing, empty, and unreadable-looking guidance paths", () =>
      Effect.gen(function* () {
        const { agentDir, configPath, directory, fs, path } = yield* tempAgentFixture(
          "pi-advisor-instructions-",
        );
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* fs.writeFileString(path.join(agentDir, "ADVISOR.md"), "   ");

        expect(
          yield* loadAdvisorInstructionsEffect(configPath, path.join(directory, "project"), true),
        ).toEqual({ paths: [] });
      }),
    );
  });
});
