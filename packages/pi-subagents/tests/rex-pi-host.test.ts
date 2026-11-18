import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import { nodeFsPromises as fs, nodePath as path } from "pi-cosmic-core/platform/node-builtins";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import {
  configureRexPiProxy,
  createRexPiRuntime,
  loadRexPiSdk,
} from "../src/boundary/rex-pi-host.mjs";

const cliExtension = `export default function(pi) {
  pi.registerFlag('pi-subagents-fast-mode', { type: 'boolean', description: 'child flag' });
  pi.on('session_start', () => pi.appendEntry('cli-flag', pi.getFlag('pi-subagents-fast-mode')));
}`;
const provider = `import { fauxProvider } from '@earendil-works/pi-ai';
export default pi => pi.registerProvider(fauxProvider({ provider: 'rex-test', models: [{id:'chosen', reasoning:true}] }).provider);`;
const projectExtension = `export default pi => pi.on('session_start', () => pi.appendEntry('trusted-project', true));`;
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const bootstrap = Effect.gen(function* () {
  const home = yield* temporaryDirectory("rex-sdk-host-");
  const cwd = path.join(home, "repo");
  const agentDir = path.join(home, "agent");
  const sessions = path.join(home, "run");
  const prompt = path.join(home, "child-system.md");
  const extension = path.join(home, "child-bridge.ts");
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      vi.stubEnv("PI_OFFLINE", "1");
      vi.stubEnv("PI_PACKAGE_DIR", getPackageDir());
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );
  const sdk = yield* Effect.promise(loadRexPiSdk);
  yield* Effect.promise(() => fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true }));
  yield* Effect.promise(() => fs.mkdir(path.join(agentDir, "extensions"), { recursive: true }));
  yield* Effect.promise(() => fs.mkdir(sessions));
  yield* Effect.promise(() => fs.writeFile(extension, cliExtension));
  yield* Effect.promise(() => fs.writeFile(prompt, "Rex child instructions"));
  yield* Effect.promise(() =>
    fs.writeFile(path.join(agentDir, "extensions", "model.ts"), provider),
  );
  yield* Effect.promise(() =>
    fs.writeFile(path.join(cwd, ".pi", "extensions", "project.ts"), projectExtension),
  );
  const args = (
    approved: boolean,
    options: { session?: string; model?: string; bridge?: string } = {},
  ) => [
    "--model",
    options.model ?? "rex-test/chosen",
    "--thinking",
    "high",
    "--pi-subagents-fast-mode",
    "--tools",
    "read,codemode,edit",
    "--exclude-tools",
    "edit,write",
    "--append-system-prompt",
    prompt,
    "--name",
    "Rex child",
    approved ? "--approve" : "--no-approve",
    "--extension",
    options.bridge ?? extension,
    ...(options.session ? ["--session", options.session] : ["--session-dir", sessions]),
  ];
  const start = (argv: string[]) => createRexPiRuntime(sdk, argv, cwd, agentDir);
  const open = (argv: string[]) =>
    Effect.acquireRelease(
      Effect.promise(() => start(argv)),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
  return { cwd, agentDir, sessions, args, start, open };
});

describe("Rex native Pi bootstrap", () => {
  it("honors inherited proxy overrides and never silently uses direct HTTP instead", () => {
    const env = { HTTPS_PROXY: "http://inherited", no_proxy: "localhost" };
    let applied: NodeJS.ProcessEnv | undefined;
    configureRexPiProxy("http://from-settings", env, {
      setGlobalProxyFromEnv: (value) => {
        applied = value;
      },
    });
    expect(applied).toEqual({
      HTTP_PROXY: "http://from-settings",
      HTTPS_PROXY: "http://inherited",
      no_proxy: "localhost",
    });
    expect(() => configureRexPiProxy(undefined, { https_proxy: "http://inherited" }, {})).toThrow(
      /proxy/i,
    );
    expect(() => configureRexPiProxy(undefined, {}, {})).not.toThrow();
  });

  it.live(
    "loads a fresh, untrusted session with exact policy, global provider, CLI bridge and flag",
    () =>
      Effect.gen(function* () {
        const { sessions, args, open } = yield* bootstrap;
        const { session } = yield* open(args(false));
        yield* Effect.promise(() => session.bindExtensions({}));
        expect(session.model).toMatchObject({ provider: "rex-test", id: "chosen" });
        expect(session.thinkingLevel).toBe("high");
        expect(session.systemPrompt).toContain("Rex child instructions");
        expect(Arr.sort(session.getActiveToolNames(), Order.String)).toEqual(["codemode", "read"]);
        expect(session.sessionManager.getSessionName()).toBe("Rex child");
        expect(session.sessionManager.getSessionDir()).toBe(sessions);
        const entries = session.sessionManager.getBranch();
        expect(entries).toContainEqual(
          expect.objectContaining({ customType: "cli-flag", data: true }),
        );
        expect(entries).not.toContainEqual(
          expect.objectContaining({ customType: "trusted-project" }),
        );
      }).pipe(Effect.scoped),
  );

  it.live("keeps registered commands executable for native interactive input", () =>
    Effect.gen(function* () {
      const { agentDir, args, open } = yield* bootstrap;
      const probe = path.join(import.meta.dirname, "fixtures", "rex-input-extension.ts");
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(agentDir, "extensions", "input.ts"),
          `export { default } from ${encodeLine(probe)};`,
        ),
      );
      const { session } = yield* open(args(false));
      yield* Effect.promise(() => session.bindExtensions({}));
      // InteractiveMode submits editor text with the SDK defaults, not the parent prompt adapter.
      yield* Effect.promise(() => session.prompt("/fixture-command from editor"));
      expect(session.sessionManager.getBranch()).toContainEqual(
        expect.objectContaining({ customType: "fixture-command", data: "from editor" }),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "opens the supplied fork/resume with its history, current model policy and trusted resources",
    () =>
      Effect.gen(function* () {
        const { cwd, sessions, args, open } = yield* bootstrap;
        const file = path.join(sessions, "fork.jsonl");
        const header = {
          type: "session",
          id: "stored",
          cwd,
          timestamp: "2026-01-01T00:00:00.000Z",
          version: 3,
        };
        const entry = {
          type: "message",
          id: "previous",
          parentId: null,
          timestamp: header.timestamp,
          message: { role: "user", content: "previous task", timestamp: 1 },
        };
        yield* Effect.promise(() =>
          fs.writeFile(file, `${encodeLine(header)}\n${encodeLine(entry)}\n`),
        );
        const runtime = yield* open(args(true, { session: file }));
        const { session } = runtime;
        yield* Effect.promise(() => session.bindExtensions({}));
        expect(session.sessionId).toBe("stored");
        expect(session.messages).toContainEqual(entry.message);
        expect(session.sessionManager.getBranch()).toContainEqual(
          expect.objectContaining({ customType: "trusted-project" }),
        );
        expect(session.getActiveToolNames()).not.toContain("edit");
        yield* Effect.promise(() => runtime.newSession());
        expect(runtime.session.sessionId).not.toBe(session.sessionId);
        expect(Arr.sort(runtime.session.getActiveToolNames(), Order.String)).toEqual([
          "codemode",
          "read",
        ]);
        expect(runtime.session.model?.id).toBe("chosen");
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses to fuzzy-match the chosen model, invent missing history, or drop a launch flag",
    () =>
      Effect.gen(function* () {
        const { cwd, sessions, args, start } = yield* bootstrap;
        yield* Effect.promise(() =>
          expect(start(args(false, { model: "rex-test/chos" }))).rejects.toThrow(
            /model unavailable/i,
          ),
        );
        yield* Effect.promise(() =>
          expect(
            start(args(false, { session: path.join(sessions, "missing.jsonl") })),
          ).rejects.toThrow(),
        );
        yield* Effect.promise(() =>
          expect(start([...args(false), "--no-tools"])).rejects.toThrow(/argument/i),
        );
        const bridge = path.join(cwd, "missing-flag.ts");
        yield* Effect.promise(() => fs.writeFile(bridge, "export default () => {};"));
        yield* Effect.promise(() =>
          expect(start(args(false, { bridge }))).rejects.toThrow(/fast-mode/),
        );
      }).pipe(Effect.scoped),
  );
});
