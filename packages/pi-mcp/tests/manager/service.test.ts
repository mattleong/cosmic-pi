import { expect, it } from "@effect/vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { confirmMcpAction } from "../../src/boundary/host-ui.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import { JsonSchemaValidator } from "../../src/boundary/schema-validator.ts";
import type { McpResolvedConfig } from "../../src/config/model.ts";
import { decodeMcpServer } from "../../src/config/schema.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";
import { McpManager } from "../../src/manager/service.ts";
import { McpResults } from "../../src/results/service.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { resultPage } from "../../src/ui/result-view.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { managerHarness, requestOf } from "../fixtures/manager.ts";
import {
  fakeAuth,
  fakeConfigStore,
  fakeConnection,
  runWith,
  stdioDefinition,
  testConfig,
  testServer,
} from "../fixtures/services.ts";

const projection = { maxOutputBytes: 4096, images: false };

const fixture = (
  servers?: McpResolvedConfig["servers"],
  listing: {
    readonly toolNames?: ReadonlyArray<string>;
    readonly denyTools?: ReadonlyArray<string>;
    readonly unavailable?: boolean;
  } = {},
) => {
  let reads = 0;
  let opens = 0;
  let requests = 0;
  let trusted = true;
  const store = fakeConfigStore(
    testConfig({
      servers: servers ?? {
        a: testServer("a", {
          identity: "private-config-hash",
          directory: "/private/path",
          definition: stdioDefinition({
            command: "private-command",
            args: ["private-argument"],
            denyTools: listing.denyTools ?? [],
          }),
        }),
      },
    }),
  );
  const activity = McpActivity.layer();
  const auth = Layer.succeed(
    McpAuth,
    fakeAuth({
      access: () =>
        Effect.sync(() => {
          reads += 1;
          return undefined;
        }),
      status: () => Effect.succeed({ state: "unchecked" }),
    }),
  );
  const connector = Layer.succeed(McpConnector, {
    open: () =>
      Effect.suspend(() => {
        opens += 1;
        return fakeConnection({
          request: (input) =>
            Effect.gen(function* () {
              requests += 1;
              if (listing.unavailable)
                return yield* boundaryError(
                  "unsupported",
                  "completed",
                  "Tools unavailable.",
                  "rpc-method-not-found",
                );
              return {
                action: input.action,
                outcome: "completed" as const,
                result: {
                  ttlMs: 60_000,
                  tools: (listing.toolNames ?? ["lookup"]).map((name) => ({
                    name,
                    description: "cached fixture",
                    inputSchema: { type: "object" },
                  })),
                },
              };
            }),
        });
      }),
  });
  const connections = McpConnections.layer({ isTrusted: () => trusted }).pipe(
    Layer.provide(Layer.mergeAll(store.layer, auth, connector, activity)),
  );
  const discovery = McpDiscovery.layer.pipe(Layer.provide(Layer.mergeAll(connections, activity)));
  const results = McpResults.layer({ maxEntries: 2 });
  const execution = McpExecution.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        connections,
        discovery,
        auth,
        results,
        Layer.succeed(JsonSchemaValidator, { validateJsonSchema: () => Effect.void }),
      ),
    ),
  );
  const manager = McpManager.layer.pipe(
    Layer.provide(Layer.mergeAll(connections, discovery, execution, results)),
  );
  return {
    run: runWith(
      Effect.all({
        manager: Effect.service(McpManager),
        execution: Effect.service(McpExecution),
        results: Effect.service(McpResults),
        connections: Effect.service(McpConnections),
        discovery: Effect.service(McpDiscovery),
        activity: Effect.service(McpActivity),
      }),
      Layer.mergeAll(manager, connections, discovery, execution, activity, results),
    ),
    counts: () => ({ reads, opens, requests }),
    untrust: () => {
      trusted = false;
    },
    replace: Effect.suspend(() => {
      const previous = store.current();
      return store.publish({
        ...previous,
        revision: previous.revision + 1,
        servers: { a: { ...previous.servers.a!, identity: "replacement" } },
      });
    }),
  };
};

for (const mode of ["capacity", "revocation"] as const) {
  it.effect(
    `an open result viewer immediately withdraws text on ${mode} without replay or read loops`,
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run(function* ({ manager, execution, results }) {
          const original = yield* execution.execute(
            { action: "tools.call", server: "a", tool: "lookup", arguments: {} },
            projection,
          );
          const id = original.reply.resultId!;
          for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
          const { component, requests } = managerHarness(manager.snapshot, {
            screen: "result",
            resultId: id,
            height: 30,
          });
          yield* manager.subscribe(() => component.update());
          yield* Effect.addFinalizer(() => Effect.sync(() => component.dispose()));
          const initial = requestOf(requests, "result");
          const originalPage = resultPage(
            (yield* execution.execute(
              { action: "result.read", id },
              { ...projection, maxOutputBytes: 16_384 },
            )).reply,
          );
          initial.deliver(originalPage);
          expect(component.render(160).join("\n")).toContain("cached fixture");
          const before = f.counts();
          if (mode === "capacity") {
            yield* execution.execute({ action: "status" }, projection);
            yield* execution.execute({ action: "status" }, projection);
          } else yield* results.revoke();
          expect(component.render(160).join("\n")).not.toContain("cached fixture");
          initial.deliver(originalPage);
          expect(component.render(160).join("\n")).not.toContain("cached fixture");
          for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
          const latest = requestOf(requests, "result");
          const count = requests.length;
          latest.deliver(
            yield* execution
              .execute({ action: "result.read", id }, { ...projection, maxOutputBytes: 16_384 })
              .pipe(
                Effect.map((value) => resultPage(value.reply)),
                Effect.orElseSucceed(() => undefined),
              ),
          );
          for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
          expect(requests).toHaveLength(count);
          component.handleInput("n");
          component.handleInput("p");
          expect(requests).toHaveLength(count);
          expect(f.counts()).toEqual(before);
        });
      }),
  );
}

it.effect(
  "repeated dashboard and cached browsing reads neither credentials nor retained-result capacity",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run(function* ({ manager, execution }) {
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* manager.refresh),
        ).not.toMatch(/private-config-hash|private-command|private-argument|private\/path/);
        const retained = yield* execution.execute({ action: "status" }, projection);
        expect(retained.reply.resultId).toBeDefined();
        for (let index = 0; index < 40; index += 1) {
          expect((yield* manager.refresh).servers[0]?.auth).toBe("unchecked");
          expect(
            (yield* manager.cached({ family: "tools", server: "a", query: "lookup" })).entries,
          ).toEqual([]);
        }
        expect(f.counts()).toEqual({ reads: 0, opens: 0, requests: 0 });
        const read = yield* execution.execute(
          { action: "result.read", id: retained.reply.resultId! },
          projection,
        );
        expect(read.reply.resultId).toBe(retained.reply.resultId);
      });
    }),
);

it.effect(
  "manager metadata evidence distinguishes initial, withdrawn, and unauthorized states",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run(function* ({ manager, connections }) {
        const initial = (yield* manager.refresh).servers[0]!;
        expect(initial.metadataState).toBe("undiscovered");
        expect(initial.metadata).toBeUndefined();
        const receipt = yield* manager.dispatch(yield* manager.capture(initial, "refresh"));
        expect(receipt?.tools).toBe(1);
        const connected = (yield* manager.refresh).servers[0]!;
        expect(connected.metadataState).toBe("ready");
        yield* connections.disconnect("a");
        const withdrawn = (yield* manager.refresh).servers[0]!;
        expect(withdrawn.metadataState).toBe("invalidated");
        expect(withdrawn.metadata).toBeUndefined();
        f.untrust();
        expect(manager.snapshot().servers[0]).toMatchObject({
          metadataState: "unavailable",
          metadata: undefined,
        });
      });
    }),
);

it.effect.each([0, 125])(
  "discovery feedback counts all permitted tools, not a displayed page: %s",
  (count) =>
    Effect.gen(function* () {
      const f = fixture(undefined, {
        toolNames: [...Array.from({ length: count }, (_, index) => `tool-${index}`), "hidden"],
        denyTools: ["hidden"],
      });
      yield* f.run(function* ({ manager, execution }) {
        const row = (yield* manager.refresh).servers[0]!;
        const receipt = yield* manager.dispatch(yield* manager.capture(row, "refresh"));
        expect(receipt).toMatchObject({ tools: count, support: { tools: true } });
        expect((yield* manager.refresh).servers[0]?.metadataState).toBe(
          count === 0 ? "empty" : "ready",
        );
        const command = yield* execution.execute({ action: "refresh", server: "a" }, projection);
        expect(command.reply.data).toMatchObject({
          result: { tools: count, support: { tools: true } },
        });
      });
    }),
);

it.effect("successful discovery keeps unsupported tools distinct from a loaded empty catalog", () =>
  Effect.gen(function* () {
    const f = fixture(undefined, { unavailable: true });
    yield* f.run(function* ({ manager }) {
      const row = (yield* manager.refresh).servers[0]!;
      const receipt = yield* manager.dispatch(yield* manager.capture(row, "refresh"));
      expect(receipt).toMatchObject({
        tools: 0,
        support: { tools: false },
        diagnostics: [{ family: "tools" }],
      });
      expect((yield* manager.refresh).servers[0]?.metadataState).toBe("unsupported");
    });
  }),
);

it.effect.each([false, true])(
  "distinguishes disabled configuration from invalid overrides without permitting execution: invalid=%s",
  (invalid) =>
    Effect.gen(function* () {
      const server = {
        id: "a",
        identity: "disabled-config",
        credentialIdentity: "disabled-credentials",
        scope: "project" as const,
        directory: "/project",
        enabled: false,
      };
      const error = yield* decodeMcpServer({
        url: "https://private-server.test",
        auth: { type: "none", "private-secret": "private-secret" },
      }).pipe(Effect.flip);
      const f = fixture({
        a: invalid ? { ...server, diagnostic: error.message } : server,
      });
      yield* f.run(function* ({ manager }) {
        const row = (yield* manager.refresh).servers[0]!;
        expect(row.invalid).toBe(invalid);
        expect(row.diagnostic).toBe(invalid ? error.message : undefined);
        if (invalid) expect(row.diagnostic).toContain('"auth"');
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(row)).not.toMatch(
          /private-secret|private-server/,
        );
        expect(row.enabled).toBe(false);
        expect(row.actions.find((choice) => choice.action === "connect")).toMatchObject({
          enabled: false,
          reason: invalid ? "invalid" : "disabled",
        });
        expect((yield* manager.capture(row, "connect").pipe(Effect.flip)).kind).toBe("denied");
        expect(f.counts()).toEqual({ reads: 0, opens: 0, requests: 0 });
      });
    }),
);

it.effect("a confirmation ticket cannot dispatch to a reconfigured server with the same name", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.run(function* ({ manager }) {
      const row = (yield* manager.refresh).servers[0]!;
      const ticket = yield* manager.capture(row, "connect");
      const context = yield* Effect.context();
      const ctx = extensionContextFixture({
        ui: { confirm: () => Effect.runPromiseWith(context)(f.replace.pipe(Effect.as(true))) },
      });
      expect(yield* confirmMcpAction(ctx, "Confirm displayed action", () => true)).toBe(true);
      expect((yield* manager.dispatch(ticket).pipe(Effect.flip)).kind).toBe("stale");
      expect(f.counts()).toEqual({ reads: 0, opens: 0, requests: 0 });
    });
  }),
);

it.effect(
  "connection transition invalidates an earlier action ticket inside dispatch admission",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run(function* ({ manager, connections }) {
        const ticket = yield* manager.capture((yield* manager.refresh).servers[0]!, "connect");
        yield* connections.connect("a");
        const before = f.counts();
        expect((yield* connections.connect("a", ticket.binding).pipe(Effect.flip)).kind).toBe(
          "stale",
        );
        expect(f.counts()).toEqual(before);
      });
    }),
);

it.effect(
  "disconnect withdraws cached detail and exposes only one activity row for shared metadata work",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.run(function* ({ manager, connections, discovery, activity }) {
        const first = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        const second = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(activity.snapshot().filter((entry) => entry.operation === "connect")).toHaveLength(
          1,
        );
        expect(activity.snapshot().filter((entry) => entry.operation === "refresh")).toHaveLength(
          1,
        );
        const page = yield* manager.cached({ family: "tools", server: "a" });
        expect(page.entries).toHaveLength(1);
        const ref = page.entries[0]!.ref;
        yield* connections.disconnect("a");
        expect((yield* manager.cached({ family: "tools", server: "a" })).entries).toEqual([]);
        expect((yield* manager.cachedDetail(ref).pipe(Effect.flip)).kind).toBe("stale");
      });
    }),
);
