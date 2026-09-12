import { expect, it } from "@effect/vitest";
import type { Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmMcpAction } from "../../src/boundary/host-ui.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import { JsonSchemaValidator } from "../../src/boundary/schema-validator.ts";
import type { McpResolvedConfig } from "../../src/config/model.ts";
import { DEFAULT_MCP_SETTINGS, decodeMcpServer } from "../../src/config/schema.ts";
import { McpConfigStore } from "../../src/config/store.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";
import { McpManager } from "../../src/manager/service.ts";
import { McpResults } from "../../src/results/service.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { McpManagerComponent, type McpViewRequest } from "../../src/ui/manager.ts";
import { managerSelection } from "../../src/ui/manager-state.ts";
import { resultPage } from "../../src/ui/result-view.ts";
import { boundaryError } from "../../src/client/errors.ts";

const fixture = (
  servers?: McpResolvedConfig["servers"],
  listing: {
    readonly toolNames?: ReadonlyArray<string>;
    readonly denyTools?: ReadonlyArray<string>;
    readonly unavailable?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    let reads = 0;
    let opens = 0;
    let requests = 0;
    let trusted = true;
    let publish: ((config: McpResolvedConfig) => Effect.Effect<void>) | undefined;
    const config = yield* Ref.make<McpResolvedConfig>({
      revision: 1,
      trusted: true,
      settings: { ...DEFAULT_MCP_SETTINGS, enabled: true },
      diagnostics: [],
      servers: servers ?? {
        a: {
          id: "a",
          identity: "private-config-hash",
          scope: "global",
          directory: "/private/path",
          enabled: true,
          definition: {
            transport: "stdio",
            command: "private-command",
            args: ["private-argument"],
            environment: {},
            denyTools: listing.denyTools ?? [],
          },
        },
      },
    });
    const activity = McpActivity.layer();
    const auth = Layer.succeed(McpAuth, {
      access: () =>
        Effect.sync(() => {
          reads += 1;
          return undefined;
        }),
      status: () => Effect.succeed({ state: "unchecked" }),
      login: () => Effect.succeed({ state: "ready" }),
      logout: () => Effect.void,
      reject: () => Effect.void,
      completeLogin: () => Effect.void,
      finalizationFailed: () => Effect.void,
      revoke: Effect.void,
    });
    const store = Layer.succeed(McpConfigStore, {
      snapshot: Ref.get(config),
      subscribe: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            publish = listener;
          }),
          () =>
            Effect.sync(() => {
              publish = undefined;
            }),
        ),
      reload: Ref.get(config),
      setServer: () => Ref.get(config),
      removeServer: () => Ref.get(config),
      setSettings: () => Ref.get(config),
    });
    const connector = Layer.succeed(McpConnector, {
      open: () =>
        Effect.gen(function* () {
          opens += 1;
          const closed = yield* Ref.make(false);
          const terminal = yield* Deferred.make<void>();
          const close = Ref.set(closed, true).pipe(
            Effect.andThen(Deferred.succeed(terminal, undefined)),
            Effect.asVoid,
          );
          yield* Effect.addFinalizer(() => close);
          return {
            capabilities: { tools: true, resources: false, prompts: false },
            changes: Stream.never,
            terminal: Deferred.await(terminal),
            health: Ref.get(closed).pipe(
              Effect.map((value) => ({ closed: value, cleanupUnconfirmed: false })),
            ),
            close,
            setToken: () => Effect.void,
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
          };
        }),
    });
    const connections = McpConnections.layer({ isTrusted: () => trusted }).pipe(
      Layer.provide(Layer.mergeAll(store, auth, connector, activity)),
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
      layer: Layer.mergeAll(manager, connections, discovery, execution, activity, results),
      counts: () => ({ reads, opens, requests }),
      untrust: () => {
        trusted = false;
      },
      replace: Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(config, (previous) => ({
          ...previous,
          revision: previous.revision + 1,
          servers: { a: { ...previous.servers.a!, identity: "replacement" } },
        }));
        if (publish) yield* publish(next);
      }),
    };
  });

for (const mode of ["capacity", "revocation"] as const) {
  it.effect(
    `an open result viewer immediately withdraws text on ${mode} without replay or read loops`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const manager = yield* McpManager;
          const execution = yield* McpExecution;
          const results = yield* McpResults;
          const original = yield* execution.execute(
            { action: "tools.call", server: "a", tool: "lookup", arguments: {} },
            { maxOutputBytes: 4096, images: false },
          );
          const id = original.reply.resultId!;
          for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
          const requests: McpViewRequest[] = [];
          // SAFETY: The controlled pure component uses only theme fg/bold callbacks.
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          } as Theme;
          const component = new McpManagerComponent({
            theme,
            snapshot: manager.snapshot,
            selection: managerSelection("result", undefined, id),
            height: () => 30,
            requestRender() {},
            finish() {},
            load: (request) => {
              requests.push(request);
            },
            matchesKeybinding: () => false,
            keybindingLabel: (_id, fallback) => fallback,
          });
          yield* manager.subscribe(() => component.update());
          yield* Effect.addFinalizer(() => Effect.sync(() => component.dispose()));
          const initial = requests.at(-1)!;
          if (initial.kind !== "result") throw new Error("fixture");
          const originalPage = resultPage(
            (yield* execution.execute(
              { action: "result.read", id },
              { maxOutputBytes: 16_384, images: false },
            )).reply,
          );
          initial.deliver(originalPage);
          expect(component.render(160).join("\n")).toContain("cached fixture");
          const before = f.counts();
          if (mode === "capacity") {
            yield* execution.execute({ action: "status" }, { maxOutputBytes: 4096, images: false });
            yield* execution.execute({ action: "status" }, { maxOutputBytes: 4096, images: false });
          } else yield* results.revoke("a");
          expect(component.render(160).join("\n")).not.toContain("cached fixture");
          initial.deliver(originalPage);
          expect(component.render(160).join("\n")).not.toContain("cached fixture");
          for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
          const latest = requests.at(-1)!;
          if (latest.kind !== "result") throw new Error("fixture");
          const count = requests.length;
          latest.deliver(
            yield* execution
              .execute({ action: "result.read", id }, { maxOutputBytes: 16_384, images: false })
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
        }).pipe(Effect.provide(f.layer));
      }),
  );
}

it.effect(
  "repeated dashboard and cached browsing reads neither credentials nor retained-result capacity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
        const execution = yield* McpExecution;
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* manager.refresh),
        ).not.toMatch(/private-config-hash|private-command|private-argument|private\/path/);
        const retained = yield* execution.execute(
          { action: "status" },
          { maxOutputBytes: 4096, images: false },
        );
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
          { maxOutputBytes: 4096, images: false },
        );
        expect(read.reply.resultId).toBe(retained.reply.resultId);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "manager metadata evidence distinguishes initial, withdrawn, and unauthorized states",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
        const initial = (yield* manager.refresh).servers[0]!;
        expect(initial.metadataState).toBe("undiscovered");
        expect(initial.metadata).toBeUndefined();
        const receipt = yield* manager.dispatch(yield* manager.capture(initial, "refresh"));
        expect(receipt?.tools).toBe(1);
        const connected = (yield* manager.refresh).servers[0]!;
        expect(connected.metadataState).toBe("ready");
        const connections = yield* McpConnections;
        yield* connections.disconnect("a");
        const withdrawn = (yield* manager.refresh).servers[0]!;
        expect(withdrawn.metadataState).toBe("invalidated");
        expect(withdrawn.metadata).toBeUndefined();
        f.untrust();
        expect(manager.snapshot().servers[0]).toMatchObject({
          metadataState: "unavailable",
          metadata: undefined,
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect.each([0, 125])(
  "discovery feedback counts all permitted tools, not a displayed page: %s",
  (count) =>
    Effect.gen(function* () {
      const f = yield* fixture(undefined, {
        toolNames: [...Array.from({ length: count }, (_, index) => `tool-${index}`), "hidden"],
        denyTools: ["hidden"],
      });
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
        const row = (yield* manager.refresh).servers[0]!;
        const receipt = yield* manager.dispatch(yield* manager.capture(row, "refresh"));
        expect(receipt).toMatchObject({ tools: count, support: { tools: true } });
        expect((yield* manager.refresh).servers[0]?.metadataState).toBe(
          count === 0 ? "empty" : "ready",
        );
        const execution = yield* McpExecution;
        const command = yield* execution.execute(
          { action: "refresh", server: "a" },
          { maxOutputBytes: 4096, images: false },
        );
        expect(command.reply.data).toMatchObject({
          result: { tools: count, support: { tools: true } },
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("successful discovery keeps unsupported tools distinct from a loaded empty catalog", () =>
  Effect.gen(function* () {
    const f = yield* fixture(undefined, { unavailable: true });
    yield* Effect.gen(function* () {
      const manager = yield* McpManager;
      const row = (yield* manager.refresh).servers[0]!;
      const receipt = yield* manager.dispatch(yield* manager.capture(row, "refresh"));
      expect(receipt).toMatchObject({
        tools: 0,
        support: { tools: false },
        diagnostics: [{ family: "tools" }],
      });
      expect((yield* manager.refresh).servers[0]?.metadataState).toBe("unsupported");
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect.each([false, true])(
  "distinguishes disabled configuration from invalid overrides without permitting execution: invalid=%s",
  (invalid) =>
    Effect.gen(function* () {
      const server = {
        id: "a",
        identity: "disabled-config",
        scope: "project" as const,
        directory: "/project",
        enabled: false,
      };
      const error = yield* decodeMcpServer({
        url: "https://private-server.test",
        auth: { type: "none", "private-secret": "private-secret" },
      }).pipe(Effect.flip);
      const f = yield* fixture({
        a: invalid ? { ...server, diagnostic: error.message } : server,
      });
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
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
        expect(yield* Effect.result(manager.capture(row, "connect"))).toMatchObject({
          _tag: "Failure",
          failure: { kind: "denied" },
        });
        expect(f.counts()).toEqual({ reads: 0, opens: 0, requests: 0 });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("a confirmation ticket cannot dispatch to a reconfigured server with the same name", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const manager = yield* McpManager;
      const row = (yield* manager.refresh).servers[0]!;
      const ticket = yield* manager.capture(row, "connect");
      const context = yield* Effect.context();
      const ui: Pick<ExtensionContext["ui"], "confirm"> = {
        confirm: () => Effect.runPromiseWith(context)(f.replace.pipe(Effect.as(true))),
      };
      // SAFETY: The confirmation boundary reads only the supplied ui.confirm callback.
      const ctx = { ui } as ExtensionContext;
      expect(yield* confirmMcpAction(ctx, "Confirm displayed action", () => true)).toBe(true);
      expect(yield* Effect.result(manager.dispatch(ticket))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "stale" },
      });
      expect(f.counts()).toEqual({ reads: 0, opens: 0, requests: 0 });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "connection transition invalidates an earlier action ticket inside dispatch admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
        const connections = yield* McpConnections;
        const ticket = yield* manager.capture((yield* manager.refresh).servers[0]!, "connect");
        yield* connections.connect("a");
        const before = f.counts();
        expect(yield* Effect.result(connections.connect("a", ticket.binding))).toMatchObject({
          failure: { kind: "stale" },
        });
        expect(f.counts()).toEqual(before);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "disconnect withdraws cached detail and exposes only one activity row for shared metadata work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const manager = yield* McpManager;
        const connections = yield* McpConnections;
        const discovery = yield* McpDiscovery;
        const activity = yield* McpActivity;
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
        expect(yield* Effect.result(manager.cachedDetail(ref))).toMatchObject({
          failure: { kind: "stale" },
        });
      }).pipe(Effect.provide(f.layer));
    }),
);
