// Public Pi SDK integration boundary; native executions use real local files and shell settings.
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { createToolPresentationHarness } from "../../testing";
import { CORE_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { registerWritePreviewTool } from "../../src/tools/renderers/registration";
import { step } from "../support/effect-test";
import { codePreviewsUnderTest, offlineModels, scopedSession } from "../support/sdk-session";
import { quietLoader, quietSettings } from "pi-cosmic-core/testing/sdk";

for (const activeWrite of [false, true])
  it.live(
    `renderer routing retains native execution/settings/images and write selection: ${activeWrite}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-builtin-sdk-" });
        const imageData =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=";
        yield* fs.writeFile(`${directory}/image.png`, Buffer.from(imageData, "base64"));
        yield* fs.writeFileString(`${directory}/source.txt`, "NATIVE_READ_CONTENT");
        const models = yield* offlineModels(directory);
        const settings = quietSettings({
          defaultTools: activeWrite ? ["read", "bash", "write"] : ["read", "bash"],
          shellPath: "/bin/sh",
          shellCommandPrefix: "export PREVIEW_NATIVE_PREFIX=kept;",
          images: { autoResize: false },
        });
        const registrations: ToolDefinition<any, any, any>[] = [];
        const factory = codePreviewsUnderTest(
          directory,
          {
            tools: [...CORE_CODE_PREVIEW_TOOLS],
            syntaxHighlighting: false,
            toolCallTiming: false,
            toolCallCollapsedStyle: "compact",
          },
          {
            api: (pi) => ({
              registerTool(tool) {
                registrations.push(tool);
                pi.registerTool(tool);
              },
            }),
            registerRenderers: registerWritePreviewTool,
          },
        );
        const loader = yield* quietLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          extensionFactories: [{ name: "code-previews", factory }],
        });
        const session = yield* scopedSession({ cwd: directory, models, settings, loader });
        const before = new Map(
          ["bash", "read", "edit", "grep", "find", "ls"].map((name) => [
            name,
            session.getToolDefinition(name),
          ]),
        );
        const active = session.getActiveToolNames();
        const callable = session.getCallableToolNames();
        yield* step(() => session.bindExtensions({ mode: "print" }));
        assert.deepEqual(
          registrations.map((tool) => tool.name),
          ["write"],
        );
        assert.deepEqual(session.getActiveToolNames(), active);
        assert.deepEqual(session.getCallableToolNames(), callable);
        assert.equal(registrations[0]?.defaultActive, activeWrite);
        for (const [name, definition] of before) {
          assert.ok(definition);
          assert.equal(session.getToolDefinition(name), definition);
          assert.equal(
            session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path,
            `builtin:${name}`,
          );
        }
        const bash = session.agent.state.tools.find((tool) => tool.name === "bash");
        const read = session.agent.state.tools.find((tool) => tool.name === "read");
        assert.ok(bash);
        assert.ok(read);
        const shell = yield* step(() =>
          bash.execute(
            "native-shell",
            { command: 'printf "%s:%s" "$PREVIEW_NATIVE_PREFIX" "$0"' },
            undefined,
          ),
        );
        assert.ok(
          shell.content.some((part) => part.type === "text" && part.text === "kept:/bin/sh"),
          "Native shell prefix and configured shell must remain effective",
        );
        const content = yield* step(() =>
          read.execute("native-read", { path: "source.txt" }, undefined),
        );
        assert.ok(
          content.content.some(
            (part) => part.type === "text" && part.text === "NATIVE_READ_CONTENT",
          ),
        );
        const image = yield* step(() =>
          read.execute("native-image", { path: "image.png" }, undefined),
        );
        const nativeImage = image.content.find((part) => part.type === "image");
        assert.ok(nativeImage?.type === "image");
        assert.equal(nativeImage.data, imageData);
        const original = structuredClone(image);
        const renderers = session.extensionRunner.resolveToolRenderers("read", () =>
          before.get("read"),
        );
        assert.ok(renderers);
        const harness = createToolPresentationHarness(renderers);
        for (const { text } of harness.cycle({ path: "image.png" }, image))
          assert.equal(text.includes(imageData), false);
        assert.deepEqual(image, original);
        assert.equal(
          image.content.find((part) => part.type === "image"),
          nativeImage,
        );
        const write = registrations[0];
        assert.ok(write);
        const receipt = yield* step(() =>
          write.execute(
            "hook-write",
            {
              path: "source.txt",
              content: "AFTER",
            },
            undefined,
            undefined,
            session.extensionRunner.createToolContext("hook-write", undefined),
          ),
        );
        assert.equal(yield* fs.readFileString(`${directory}/source.txt`), "AFTER");
        assert.deepEqual(receipt.details.codePreviewBeforeWrite, {
          kind: "content",
          byteLength: 19,
        });
      }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
