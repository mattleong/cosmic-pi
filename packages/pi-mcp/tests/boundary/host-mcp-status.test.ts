import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ACTIVITY_EVENT, ACTIVITY_HOST, type ActivityEnvelope } from "pi-cosmic-ui/activity";
import {
  acquireMcpStatusHost,
  makeMcpStatusHost,
  type McpStatusHostOptions,
} from "../../src/boundary/host-mcp-status.ts";
import { makeMcpActivity, type McpActivityContract } from "../../src/activity/service.ts";
import type { McpStatusCounts } from "../../src/activity/model.ts";

const serialize = <Value>(value: Value) => JSON.stringify(value);
const rejects = <A>(run: () => Promise<A>) => Effect.promise(() => expect(run()).rejects.toThrow());
const setup = (activity: McpActivityContract, mode: ExtensionContext["mode"] = "tui") => {
  const events = createEventBus();
  const status = new Map<string, string>();
  const envelopes: ActivityEnvelope[] = [];
  const publications: string[] = [];
  const listeners = new Set<() => void>();
  const opened: string[] = [];
  let current = true;
  let counts: McpStatusCounts = { connected: 0, active: 0, queued: 0, attention: 0 };
  // SAFETY: Only these context fields are reachable in this owned status-boundary fixture.
  const ctx = {
    mode,
    ui: {
      setStatus: (key: string, text?: string) => {
        publications.push(serialize({ key, text }));
        if (text === undefined) status.delete(key);
        else status.set(key, text);
      },
    },
  } as ExtensionContext;
  events.on(ACTIVITY_EVENT, (data) => {
    // SAFETY: The tested typed provider is the sole producer on this private bus.
    envelopes.push(data as ActivityEnvelope);
    publications.push(serialize(data));
  });
  const options: McpStatusHostOptions = {
    events,
    ctx,
    sessionId: "session",
    activity,
    counts: () => counts,
    isCurrent: () => current,
    subscribeCounts: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openManager: (server) => {
      opened.push(server);
      return Promise.resolve();
    },
  };
  const announce = (hostToken = {}, available = true) =>
    events.emit(ACTIVITY_HOST, { version: 1, sessionId: "session", hostToken, available });
  return {
    options,
    status,
    envelopes,
    publications,
    listeners,
    opened,
    announce,
    /** The latest Activity registration, acknowledged as owned. */
    register: () => {
      const registration = envelopes.findLast((entry) => entry.operation === "register")!;
      registration.acknowledge?.(true);
      return registration;
    },
    revoke: () => {
      current = false;
    },
    setCounts: (next: McpStatusCounts) => {
      counts = next;
      for (const listener of listeners) listener();
    },
  };
};

describe("MCP Activity and keyed footer host", () => {
  it.effect(
    "keeps fallback until explicit Activity ownership acknowledgment and restores it on host loss",
    () =>
      Effect.gen(function* () {
        const journal = yield* makeMcpActivity();
        const handle = yield* journal.begin({ operation: "auth", server: "docs" });
        yield* journal.update(handle, { phase: "browser-approval" });
        const h = setup(journal);
        const host = makeMcpStatusHost(h.options);
        const fallback = h.status.get("pi-mcp");
        expect(fallback).toBeDefined();
        const token = {};
        h.announce(token);
        expect(h.status.get("pi-mcp")).toBe(fallback);
        const registration = h.envelopes.findLast((entry) => entry.operation === "register")!;
        expect(registration.items).toMatchObject([
          { kind: "command", status: "needs-input", inputTarget: "user" },
        ]);
        registration.acknowledge?.(true);
        expect(h.status.has("pi-mcp")).toBe(false);
        h.announce(token, false);
        expect(h.status.get("pi-mcp")).toBe(fallback);
        host.dispose();
        expect(h.status.has("pi-mcp")).toBe(false);
        expect(h.listeners.size).toBe(0);
      }),
  );

  it.effect("actions inspect current revisions only and expose no authentication authority", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity();
      const privateAttempt = {
        operation: "auth" as const,
        server: "docs",
        authorizationUrl: "https://issuer.invalid?state=PRIVATE-STATE",
        callbackUrl: "http://127.0.0.1?code=PRIVATE-CODE",
        accessToken: "PRIVATE-TOKEN",
        credentialIdentity: "PRIVATE-GRANT",
      };
      const handle = yield* journal.begin(privateAttempt);
      const h = setup(journal);
      const host = makeMcpStatusHost(h.options);
      h.announce();
      const registration = h.register();
      const old = journal.snapshot()[0]!;
      yield* journal.update(handle, { phase: "browser-approval" });
      const signal = yield* Effect.abortSignal;
      yield* rejects(() => registration.invoke!(old.id, "inspect", old.revision, signal));
      expect(h.opened).toEqual([]);
      const current = journal.snapshot()[0]!;
      const cancelled = AbortSignal.abort();
      yield* rejects(() =>
        registration.invoke!(current.id, "inspect", current.revision, cancelled),
      );
      yield* rejects(() => registration.invoke!(current.id, "login", current.revision, signal));
      yield* Effect.tryPromise(() =>
        registration.invoke!(current.id, "inspect", current.revision, signal),
      );
      expect(h.opened).toEqual(["docs"]);
      const failure = {
        status: "failed" as const,
        kind: "cleanup" as const,
        reason: "oauth-mutation-unresolved" as const,
        message: "PRIVATE-RAW-AUTH-ERROR",
      };
      yield* journal.finish(handle, failure);
      const failed = journal.snapshot()[0]!;
      const detail = yield* Effect.tryPromise(() =>
        registration.getDetail!(failed.id, failed.revision, signal),
      );
      expect(detail).toMatch(/mutation|credential/i);
      expect(serialize([h.publications, journal.snapshot(), detail])).not.toMatch(
        /PRIVATE|https?:|accessToken|callbackUrl|reopen|credentialIdentity/,
      );
      h.revoke();
      yield* rejects(() => registration.getDetail!(failed.id, failed.revision, signal));
      yield* rejects(() => registration.invoke!(failed.id, "inspect", failed.revision, signal));
      expect(h.opened).toEqual(["docs"]);
      host.dispose();
    }),
  );

  it.effect("old-session cleanup and subscriptions cannot clear replacement status", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity();
      const h = setup(journal);
      h.setCounts({ connected: 1, active: 0, queued: 0, attention: 0 });
      const old = makeMcpStatusHost(h.options);
      h.announce();
      const oldRegistration = h.register();
      const stalePublish = [...h.listeners][0]!;
      h.setCounts({ connected: 9, active: 2, queued: 3, attention: 1 });
      const next = makeMcpStatusHost(h.options);
      const replacement = h.status.get("pi-mcp");
      expect(replacement).toBeDefined();
      old.dispose();
      old.publish();
      stalePublish();
      oldRegistration.acknowledge?.(true);
      expect(h.status.get("pi-mcp")).toBe(replacement);
      expect(h.listeners.size).toBe(1);
      next.dispose();
      expect(h.status.has("pi-mcp")).toBe(false);
      expect(h.listeners.size).toBe(0);
    }),
  );

  it.effect("uses local snapshots without allocating results and scopes publisher cleanup", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity();
      const h = setup(journal, "rpc");
      const scope = yield* Scope.make();
      const host = yield* acquireMcpStatusHost(h.options).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      expect(h.status.size).toBe(0);
      const handle = yield* journal.begin({ operation: "connect", server: "docs" });
      h.announce();
      expect(h.envelopes).toHaveLength(0);
      expect(h.status.size).toBe(1);
      h.setCounts({ connected: 1, active: 2, queued: 3, attention: 0 });
      host.publish();
      expect(h.status.get("pi-mcp")).toMatch(/connected|active|queued/);
      yield* Scope.close(scope, Exit.void);
      expect(h.listeners.size).toBe(0);
      expect(h.status.size).toBe(0);
      yield* journal.finish(handle, { status: "failed", kind: "cleanup" });
      expect(h.status.size).toBe(0);
    }),
  );
});
