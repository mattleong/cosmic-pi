import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

// An isolated loader makes accidental transitive imports observable even if the parent cached them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "pi-cosmic-core" ||
      /^(?:effect\/(?:http|process|rpc)\/|@effect\/platform-node\/Node(?:Http|ChildProcess)|undici(?:\/|$))/.test(
        specifier,
      )
    ) {
      throw new Error(`A narrow entrypoint loaded an unrelated platform: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});

const exitListeners = process.listenerCount("exit");
const { isSubagentChildProcess } = await import("pi-cosmic-core/host-environment");
const { utf8ByteLength, utf8Prefix } = await import("pi-cosmic-core/text");
const { invokeHostCallback } = await import("pi-cosmic-core/host-session");
const { nodeFilePlatformLayer } = await import("pi-cosmic-core/platform/node-file");
const { JsonDocumentStore } = await import("pi-cosmic-core/platform/json-document");
const { makePiManagedRuntime } = await import("pi-cosmic-core/runtime");

await Promise.all([
  import("pi-cosmic-core/display"),
  import("pi-cosmic-core/message-text"),
  import("pi-cosmic-core/security"),
  import("pi-cosmic-core/projection"),
  import("pi-cosmic-core/schema/foreign-callable"),
  import("pi-cosmic-core/schema/tool-output"),
  import("pi-cosmic-core/host-command"),
  import("pi-cosmic-core/host-wake"),
  import("pi-cosmic-core/host-agent-messages"),
  import("pi-cosmic-core/session-capability"),
  import("pi-cosmic-core/settings-completion"),
  import("pi-cosmic-core/settings-dispatch"),
  import("pi-cosmic-core/coordination/subscription-refresh"),
  import("pi-cosmic-core/coordination/synchronous-ingress"),
  import("pi-cosmic-core/runtime/session-runtime"),
  import("pi-cosmic-core/config/scoped-config-store"),
  import("pi-cosmic-core/platform/safe-file"),
  import("pi-cosmic-core/platform/private-file"),
]);
assert.equal(process.listenerCount("exit"), exitListeners);

process.env.PI_SUBAGENT_CHILD = "1";
assert.equal(isSubagentChildProcess(), true);
process.env.PI_SUBAGENT_CHILD = "0";
assert.equal(isSubagentChildProcess(), false);
delete process.env.PI_SUBAGENT_CHILD;
assert.equal(isSubagentChildProcess(), false);
assert.equal(utf8ByteLength(utf8Prefix("a😀b", 5)), 5);
assert.equal(
  invokeHostCallback(() => {
    throw new Error("unavailable host");
  }, "fallback"),
  "fallback",
);

// The runtime only captures this SDK double; the effect does not invoke host methods.
const pi = Object.create(null) as ExtensionAPI;
const runtime = makePiManagedRuntime(pi, Layer.empty);
try {
  assert.equal(await runtime.run(Effect.succeed(42)), 42);
} finally {
  await runtime.dispose();
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cosmic-narrow-imports-" });
    const document = path.join(directory, "settings.json");
    const store = yield* JsonDocumentStore;
    yield* store.writeObject(document, { retained: true });
    yield* store.modifyObject(document, (current) =>
      Effect.succeed({ value: undefined, document: { ...current, updated: true } }),
    );
    assert.deepEqual(yield* store.readObject(document), { retained: true, updated: true });
  }).pipe(Effect.provide(nodeFilePlatformLayer), Effect.scoped),
);
process.stdout.write("narrow-entrypoints-ok\n");
