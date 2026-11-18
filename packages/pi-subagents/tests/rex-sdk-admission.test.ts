import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Queue from "effect/Queue";
import * as Str from "effect/String";
import * as Schema from "effect/Schema";
import { pollUntil } from "pi-cosmic-core/testing";
import { nodeFs, nodePath, nodeSpawn } from "pi-cosmic-core/platform/node-builtins";
import { guardProcessGroupAtHostExit } from "pi-cosmic-core/platform/process-group-exit-guard";
import { confirmProcessGroupExit } from "pi-cosmic-core/platform/process-tree";
import { decodeRpcEnvelope, decodeRpcPromptData } from "../src/backend/local-pi-protocol.ts";
import { ChildProcess, type ChildProcessHandle } from "../src/boundary/child-process.ts";
import type { ProcessTransportRuntime } from "../src/boundary/process-transport.ts";
import { detachedDescendantGroups, terminateProcessTree } from "../src/boundary/process-tree.ts";
import { rexSessionHost } from "../src/boundary/rex-session-host.ts";
import { backendLaunch } from "./fixtures/backend-launch.ts";
import {
  SCRIPT,
  SCRIPTED_MODEL,
  SCRIPTED_OBSERVATIONS_FILE,
  ScriptedObservation,
} from "./fixtures/scripted-pi-provider.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeObservation = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptedObservation));
const fixture = (name: string) => nodePath.join(import.meta.dirname, "fixtures", name);

// Exercise the normal launcher and SDK resolution, but never pass the developer's credentials,
// agent extensions, or project into the block. The fake Rex is the only simulated process.
const isolatedTransport = (home: string, agentDirectory: string): ProcessTransportRuntime => ({
  spawn: (exe, args, options) =>
    nodeSpawn(exe, args ?? [], {
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_PACKAGE_DIR: options?.env?.PI_PACKAGE_DIR,
        PI_SUBAGENT_CHILD: options?.env?.PI_SUBAGENT_CHILD,
        PI_SUBAGENT_RUN_ID: options?.env?.PI_SUBAGENT_RUN_ID,
        PI_SUBAGENT_PARENT_SESSION: options?.env?.PI_SUBAGENT_PARENT_SESSION,
      },
    }),
  terminate: terminateProcessTree,
  confirmGroupExit: confirmProcessGroupExit,
  guardGroup: guardProcessGroupAtHostExit,
  detachedGroups: detachedDescendantGroups,
});

const nextEnvelope = Effect.fnUntraced(function* (child: ChildProcessHandle) {
  while (true) {
    const event = yield* Queue.take(child.events);
    child.acknowledge(event);
    if (event.type === "rpc_message") return yield* decodeRpcEnvelope(event.value);
  }
});

const disposition = Effect.fnUntraced(function* (
  child: ChildProcessHandle,
  id: string,
  message: string,
  steer: boolean = false,
) {
  yield* child.send(
    steer
      ? { type: "prompt", id, message, streamingBehavior: "steer" }
      : { type: "prompt", id, message },
  );
  while (true) {
    const response = yield* nextEnvelope(child);
    if (response.type !== "response" || response.id !== id) continue;
    expect(response.success, response.error).toBe(true);
    return (yield* decodeRpcPromptData(response.data)).disposition;
  }
});

describe("SDK prompt admission in a Rex block", () => {
  it.live(
    "admits parent text literally, including commands while busy, and honors extension input hooks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-admission-" });
        const cwd = nodePath.join(home, "project");
        const agentDirectory = nodePath.join(home, "agent");
        const extensions = nodePath.join(agentDirectory, "extensions");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(extensions, { recursive: true });
        const prompts = nodePath.join(agentDirectory, "prompts");
        const skill = nodePath.join(agentDirectory, "skills", "fixture-skill");
        yield* fs.makeDirectory(prompts);
        yield* fs.makeDirectory(skill, { recursive: true });
        yield* fs.writeFileString(
          nodePath.join(prompts, "fixture-template.md"),
          "Template body: $@",
        );
        yield* fs.writeFileString(
          nodePath.join(skill, "SKILL.md"),
          "---\nname: fixture-skill\ndescription: A test skill\n---\nSkill body",
        );
        for (const name of ["scripted-pi-provider.ts", "rex-input-extension.ts"]) {
          yield* fs.writeFileString(
            nodePath.join(extensions, name),
            `export { default } from ${quotePath(fixture(name))};\n`,
          );
        }
        const rex = nodePath.join(home, "rex");
        yield* fs.writeFileString(
          rex,
          `#!/bin/sh\nexec '${process.execPath}' '${fixture("fake-rex.ts")}' "$@"\n`,
        );
        yield* fs.chmod(rex, 0o755);
        const host = rexSessionHost({
          environment: {
            REX_SESSION: `admission-${String(process.pid)}`,
            REX_BLOCK: "root",
            REX_BIN_DIR: home,
          },
          onResume: Fn.constVoid,
        });
        host.setEnabled(true);
        yield* Effect.addFinalizer(() => Effect.sync(host.close));
        const children = yield* Effect.service(ChildProcess).pipe(
          Effect.provide(
            ChildProcess.layer({
              agentDirectory,
              rexHost: host,
              transportRuntime: isolatedTransport(home, agentDirectory),
            }),
          ),
        );
        const request = backendLaunch({ cwd, model: SCRIPTED_MODEL, writeIntent: "read-only" });
        const child = yield* children.spawn(request);
        expect(yield* disposition(child, "swallowed-start", "handle extension idle")).toBe(
          "handled",
        );
        expect(host.pane(request.runId)).toBe("hidden");
        const literals = ["/fixture-template verbatim", "/skill:fixture-skill verbatim"];
        for (const [index, message] of literals.entries()) {
          expect(yield* disposition(child, `work-${String(index)}`, message)).toBe("started");
          while ((yield* nextEnvelope(child)).type !== "agent_settled") {
            // Wait for this assignment before starting the next.
          }
        }
        const observations = nodePath.join(agentDirectory, SCRIPTED_OBSERVATIONS_FILE);
        // If interpreted as a command, this would be handled without ever reaching the model.
        const held = `/fixture-command ${SCRIPT.holdTask}`;
        expect(yield* disposition(child, "work", held)).toBe("started");
        const modelHasTask = () =>
          nodeFs.existsSync(observations) &&
          Fn.pipe(nodeFs.readFileSync(observations, "utf8"), Str.includes(held));
        expect(yield* pollUntil(modelHasTask, 250, "20 millis")).toBe(true);
        const lines = Fn.pipe(yield* fs.readFileString(observations), Str.trim, Str.split("\n"));
        const seen = yield* Effect.forEach(lines, (line) => decodeObservation(line));
        expect(Arr.map(seen, (observation) => observation.prompt)).toEqual([...literals, held]);
        expect(yield* disposition(child, "guidance", "/fixture-command steer", true)).toBe(
          "queued",
        );
        expect(yield* disposition(child, "swallowed-steer", "handle extension steer", true)).toBe(
          "handled",
        );
      }).pipe(Effect.timeout("35 seconds"), Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    45_000,
  );
});
