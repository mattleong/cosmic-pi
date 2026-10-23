import { createServer, type Socket } from "node:net";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import {
  AgentDirectory,
  currentProcessIdentity,
  nodeFilePlatformLayer,
  runBoundedProcessNode,
} from "pi-cosmic-core";
import { reusedProcessIdentity } from "pi-cosmic-core/testing";
import {
  sessionRecord,
  SessionRecordFromJson,
  SocketOwnerFromJson,
  socketOwner,
  type SessionRecord,
  type SessionRecordInput,
} from "../src/registry/schema.ts";
import { writePrivateFile } from "../src/registry/private-files.ts";
import {
  FALLBACK_NAMESPACE_PREFIX,
  IntercomRegistry,
  MAX_SOCKET_PATH_BYTES,
  OwnerLiveness,
} from "../src/registry/store.ts";
import { IntercomRefused } from "../src/transport/protocol.ts";
import {
  IntercomInbound,
  serveIntercom,
  type IntercomInboundContract,
} from "../src/transport/server.ts";

const hex = (seed: string, bytes: number) =>
  Fn.pipe(seed, Str.repeat(bytes * 2), Str.slice(0, bytes * 2));

/** A PID that belonged to a process which has since exited. */
const exitedPid = runBoundedProcessNode({
  executable: process.execPath,
  args: ["-e", "process.stdout.write(String(process.pid))"],
  stdoutLimitBytes: 64,
  stderrLimitBytes: 4096,
  timeoutMillis: 10_000,
}).pipe(Effect.map(({ stdout }) => Number(stdout)));

const permissions = (fs: FileSystem.FileSystem, path: string) =>
  Effect.map(fs.stat(path), (info) => info.mode & 0o777);

/** Keeps socket paths short: macOS temporary directories are too long for `sun_path`. */
const shortTemporaryDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix });
  });

const registryHarness = (options: { readonly longAgentDirectory?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const base = yield* shortTemporaryDirectory("intercom-test-");
    const agentDirectory = options.longAgentDirectory
      ? paths.join(base, Fn.pipe("a", Str.repeat(80)))
      : paths.join(base, "agent");
    const fallbackRoot = paths.join(base, "tmp");
    yield* fs.makeDirectory(fallbackRoot, { recursive: true });
    const registry = yield* Effect.service(IntercomRegistry).pipe(
      Effect.provide(
        IntercomRegistry.layer({ fallbackRoot }).pipe(
          Layer.provide(Layer.merge(nodeFilePlatformLayer, AgentDirectory.layer(agentDirectory))),
        ),
      ),
    );
    const root = paths.join(agentDirectory, "intercom");
    const sessions = paths.join(root, "sessions");
    const sockets = paths.join(root, "s");
    const recordPath = (instance: string) => paths.join(sessions, `${instance}.json`);
    const record = (seed: string, overrides: Partial<SessionRecordInput> = {}): SessionRecord => {
      const own = currentProcessIdentity();
      const instance = hex(seed, 16);
      return sessionRecord({
        instance,
        pid: own.pid,
        started: own.started,
        sessionId: `session-${seed}`,
        name: undefined,
        cwd: "/project",
        socket: paths.join(sockets, `${instance}.sock`),
        token: hex(seed, 32),
        ...overrides,
      });
    };
    const writeRaw = (instance: string, contents: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(sessions, { recursive: true });
        yield* fs.writeFileString(recordPath(instance), contents);
        yield* fs.chmod(recordPath(instance), 0o600);
      });
    const readRecord = (instance: string) =>
      Effect.flatMap(fs.readFileString(recordPath(instance)), (source) =>
        Schema.decodeEffect(SessionRecordFromJson)(source),
      );
    const namespace = paths.join(
      fallbackRoot,
      `${FALLBACK_NAMESPACE_PREFIX}${process.getuid?.() ?? 0}`,
    );
    return {
      fs,
      paths,
      registry,
      agentDirectory,
      fallbackRoot,
      namespace,
      root,
      sessions,
      sockets,
      record,
      recordPath,
      writeRaw,
      readRecord,
    };
  });

const encodeOwner = (instance: string, pid: number, started: string | undefined) =>
  Schema.encodeEffect(SocketOwnerFromJson)(socketOwner(instance, pid, started));

/** A listener that takes connections and never answers them. */
const silentListener = (socket: string, onConnection: (peer: Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((peer) => {
        peer.on("error", () => undefined);
        onConnection(peer);
      });
      server.listen(socket, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

/**
 * A clock that stands still until told to move. A sleep, such as a probe's timeout, ends only once
 * the clock is moved past its end, so no real delay can expire one early.
 */
const manualClock = (live: Clock.Clock) => {
  let now = live.currentTimeMillisUnsafe();
  const sleepers = new Set<{ readonly until: number; readonly wake: () => void }>();
  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const sleeper = {
          until: now + Duration.toMillis(duration),
          wake: () => resume(Effect.void),
        };
        sleepers.add(sleeper);
        return Effect.sync(() => void sleepers.delete(sleeper));
      }),
  };
  return {
    clock,
    advance: (millis: number) => {
      now += millis;
      for (const sleeper of sleepers)
        if (sleeper.until <= now) {
          sleepers.delete(sleeper);
          sleeper.wake();
        }
    },
  };
};

/** Makes a path look untouched since 1970. */
const ancient = (fs: FileSystem.FileSystem, path: string) => fs.utimes(path, 1, 1);

// Directory ages are measured against the real clock.
layer(nodeFilePlatformLayer, { excludeTestServices: true })("intercom registry", (it) => {
  it.effect("writes records privately and replaces them atomically", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      // A pre-existing, wider registry directory is tightened.
      yield* h.fs.makeDirectory(h.root, { recursive: true, mode: 0o755 });
      yield* h.fs.chmod(h.root, 0o755);
      const first = h.record("a");

      yield* h.registry.write(first);
      yield* h.registry.write({ ...first, name: "renamed" });

      expect(yield* permissions(h.fs, h.root)).toBe(0o700);
      expect(yield* permissions(h.fs, h.sessions)).toBe(0o700);
      expect(yield* permissions(h.fs, h.recordPath(first.instance))).toBe(0o600);
      expect(yield* h.readRecord(first.instance)).toEqual({ ...first, name: "renamed" });
      expect(yield* h.fs.readDirectory(h.sessions)).toEqual([`${first.instance}.json`]);
      expect((yield* h.registry.list()).records).toEqual([{ ...first, name: "renamed" }]);
    }),
  );

  it.effect("refuses registry directories that are links", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const elsewhere = h.paths.join(h.fallbackRoot, "elsewhere");
      yield* h.fs.makeDirectory(elsewhere, { mode: 0o755 });
      yield* h.fs.makeDirectory(h.agentDirectory, { recursive: true });
      yield* h.fs.symlink(elsewhere, h.root);

      const failure = yield* Effect.flip(h.registry.write(h.record("a")));

      expect(failure.operation).toBe("prepare");
      expect(yield* h.fs.readDirectory(elsewhere)).toEqual([]);
      expect(yield* permissions(h.fs, elsewhere)).toBe(0o755);
    }),
  );

  it.effect("writes through neither a planted link nor a planted temporary file", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const record = h.record("b");
      yield* h.registry.write(record);
      const outside = h.paths.join(h.fallbackRoot, "outside.json");
      yield* h.fs.writeFileString(outside, "untouched");
      yield* h.fs.remove(h.recordPath(record.instance));
      yield* h.fs.symlink(outside, h.recordPath(record.instance));

      yield* h.registry.write({ ...record, name: "rewritten" });

      expect(yield* h.fs.readFileString(outside)).toBe("untouched");
      expect(yield* h.readRecord(record.instance)).toEqual({ ...record, name: "rewritten" });
    }),
  );

  it.effect("leaves no temporary file behind when a replacement fails", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const blocked = h.record("b");
      yield* h.fs.makeDirectory(h.paths.join(h.recordPath(blocked.instance), "occupied"), {
        recursive: true,
      });

      const failure = yield* Effect.flip(h.registry.write(blocked));

      expect(failure.operation).toBe("write");
      expect(yield* h.fs.readDirectory(h.sessions)).toEqual([`${blocked.instance}.json`]);
    }),
  );

  it.effect("keeps an entry already at the temporary path when the exclusive create fails", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      yield* h.fs.makeDirectory(h.sessions, { recursive: true });
      const target = h.paths.join(h.sessions, "target.json");
      const temporary = h.paths.join(h.sessions, ".target.json.planted.tmp");
      yield* h.fs.writeFileString(temporary, "someone else's");

      const failure = yield* Effect.flip(writePrivateFile(target, temporary, "{}"));

      expect(failure.reason).toBe("exists");
      expect(yield* h.fs.readFileString(temporary)).toBe("someone else's");
      expect(yield* h.fs.exists(target)).toBe(false);
    }),
  );

  it.effect("lists valid records and reports unreadable or unsafe ones without removing them", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const valid = h.record("c");
      yield* h.registry.write(valid);
      yield* h.writeRaw(hex("d", 16), "{ not json");
      // A record whose content names another instance than its file.
      yield* h.writeRaw(
        hex("e", 16),
        yield* Schema.encodeEffect(SessionRecordFromJson)(h.record("f")),
      );
      yield* h.fs.makeDirectory(h.recordPath(hex("1", 16)));
      yield* h.writeRaw(hex("2", 16), "{}");
      yield* h.fs.chmod(h.recordPath(hex("2", 16)), 0o000);
      // Readable by others, a link to a valid record, and an oversized file.
      const loose = h.record("3");
      yield* h.writeRaw(loose.instance, yield* Schema.encodeEffect(SessionRecordFromJson)(loose));
      yield* h.fs.chmod(h.recordPath(loose.instance), 0o644);
      const linked = h.record("4");
      const target = h.paths.join(h.fallbackRoot, "linked.json");
      yield* h.fs.writeFileString(
        target,
        yield* Schema.encodeEffect(SessionRecordFromJson)(linked),
      );
      yield* h.fs.chmod(target, 0o600);
      yield* h.fs.symlink(target, h.recordPath(linked.instance));
      yield* h.writeRaw(hex("5", 16), Fn.pipe(" ", Str.repeat(64 * 1024)));
      yield* h.fs.writeFileString(h.paths.join(h.sessions, "notes.txt"), "ignored");

      const listing = yield* h.registry.list();

      expect(listing.records).toEqual([valid]);
      expect(
        Arr.sort(
          Arr.map(listing.skipped, ({ file, reason }) => `${file} ${reason}`),
          Order.String,
        ),
      ).toEqual([
        `${hex("1", 16)}.json unsafe`,
        `${hex("2", 16)}.json unreadable`,
        `${hex("3", 16)}.json unsafe`,
        `${hex("4", 16)}.json unsafe`,
        `${hex("5", 16)}.json unsafe`,
        `${hex("d", 16)}.json invalid`,
        `${hex("e", 16)}.json invalid`,
      ]);
      expect(yield* h.fs.exists(h.recordPath(hex("d", 16)))).toBe(true);
    }),
  );

  it.effect("sweeps records of dead owners only", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const reused = reusedProcessIdentity();
      const live = h.record("3");
      const unknownStart = h.record("4", { started: undefined });
      const exited = h.record("5", { pid: yield* exitedPid });
      const reusedPid = h.record("6", { started: reused.started });
      for (const record of [live, unknownStart, exited, reusedPid]) yield* h.registry.write(record);
      yield* h.fs.makeDirectory(h.sockets, { recursive: true });
      yield* h.fs.writeFileString(exited.socket, "stale socket");
      yield* h.fs.writeFileString(live.socket, "live socket");
      const tombstone = (seed: string, contents: string) =>
        Effect.gen(function* () {
          const path = h.paths.join(h.sessions, `.${hex(seed, 16)}.json.${hex("0", 8)}.tombstone`);
          yield* h.fs.writeFileString(path, contents);
          yield* h.fs.chmod(path, 0o600);
          return path;
        });
      const encode = Schema.encodeEffect(SessionRecordFromJson);
      const abandoned = yield* tombstone(
        "7",
        yield* encode(h.record("7", { pid: yield* exitedPid })),
      );
      const liveTombstone = yield* tombstone("8", yield* encode(h.record("8")));
      const malformedTombstone = yield* tombstone("9", "{}");

      const swept = yield* h.registry.sweep();

      expect(swept.records).toBe(2);
      expect(
        Arr.sort(
          Arr.map((yield* h.registry.list()).records, ({ instance }) => instance),
          Order.String,
        ),
      ).toEqual(Arr.sort([live.instance, unknownStart.instance], Order.String));
      expect(yield* h.fs.exists(exited.socket)).toBe(false);
      expect(yield* h.fs.exists(live.socket)).toBe(true);
      expect(yield* h.fs.exists(abandoned)).toBe(false);
      // Tombstones without proof of a dead owner stay.
      expect(yield* h.fs.exists(liveTombstone)).toBe(true);
      expect(yield* h.fs.exists(malformedTombstone)).toBe(true);
    }),
  );

  it.effect("removes undecodable records only on evidence they are abandoned", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const own = currentProcessIdentity();
      const ownerOf = (pid: number) =>
        JSON.stringify({ version: 0, pid, started: own.started, cwd: "/project" });
      const deadOwner = hex("1", 16);
      const liveOwner = hex("2", 16);
      const fresh = hex("3", 16);
      const stale = hex("4", 16);
      const unsafe = hex("5", 16);
      const oldLiveOwner = hex("7", 16);
      yield* h.writeRaw(deadOwner, ownerOf(yield* exitedPid));
      yield* h.writeRaw(liveOwner, ownerOf(own.pid));
      // A long-running owner writes its record only at start, so age alone proves nothing.
      yield* h.writeRaw(oldLiveOwner, ownerOf(own.pid));
      yield* ancient(h.fs, h.recordPath(oldLiveOwner));
      yield* h.writeRaw(fresh, "{ not json");
      yield* h.writeRaw(stale, "{ not json");
      yield* ancient(h.fs, h.recordPath(stale));
      yield* h.writeRaw(unsafe, "{ not json");
      yield* h.fs.chmod(h.recordPath(unsafe), 0o644);
      yield* ancient(h.fs, h.recordPath(unsafe));
      // A sweeper that claimed an abandoned record and died before removing it left this.
      const tombstone = h.paths.join(h.sessions, `.${hex("6", 16)}.json.${hex("0", 8)}.tombstone`);
      yield* h.fs.writeFileString(tombstone, "{ not json");
      yield* h.fs.chmod(tombstone, 0o600);
      yield* ancient(h.fs, tombstone);
      const liveTombstoneName = `.${hex("8", 16)}.json.${hex("0", 8)}.tombstone`;
      const liveTombstone = h.paths.join(h.sessions, liveTombstoneName);
      yield* h.fs.writeFileString(liveTombstone, ownerOf(own.pid));
      yield* h.fs.chmod(liveTombstone, 0o600);
      yield* ancient(h.fs, liveTombstone);

      const swept = yield* h.registry.sweep();

      expect(swept.records).toBe(2);
      const remaining = yield* h.fs.readDirectory(h.sessions);
      expect(Arr.sort(remaining, Order.String)).toEqual(
        Arr.sort(
          [
            ...Arr.map([liveOwner, oldLiveOwner, fresh, unsafe], (instance) => `${instance}.json`),
            liveTombstoneName,
          ],
          Order.String,
        ),
      );
    }),
  );

  it.effect("keeps a session that answers without asking whether its owner runs", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const own = currentProcessIdentity();
      const answeringInstance = hex("1", 16);
      const directory = h.paths.join(h.namespace, answeringInstance);
      yield* h.fs.makeDirectory(h.namespace, { mode: 0o700 });
      yield* h.fs.makeDirectory(directory, { mode: 0o700 });
      const ownerPath = h.paths.join(directory, "owner.json");
      yield* h.fs.writeFileString(
        ownerPath,
        yield* encodeOwner(answeringInstance, own.pid, own.started),
      );
      yield* h.fs.chmod(ownerPath, 0o600);
      const answering = h.record("1", { socket: h.paths.join(directory, "intercom.sock") });
      const inbound: IntercomInboundContract = {
        describe: Effect.succeed({
          sessionId: answering.sessionId,
          cwd: "/project",
          state: "idle",
        }),
        deliver: () => Effect.succeed("woken"),
        readLast: Effect.succeed({ truncated: false, state: "idle" }),
      };
      yield* serveIntercom({ socket: answering.socket, token: answering.token }).pipe(
        Effect.provideService(IntercomInbound, inbound),
      );
      // A refusal comes from a listener that proved it holds the record's token.
      const refusing = h.record("3");
      yield* h.fs.makeDirectory(h.sockets, { recursive: true });
      yield* serveIntercom({ socket: refusing.socket, token: refusing.token }).pipe(
        Effect.provideService(IntercomInbound, {
          ...inbound,
          describe: Effect.fail(IntercomRefused.make({ code: "session_unavailable" })),
        }),
      );
      const silent = h.record("2");
      for (const record of [answering, refusing, silent]) yield* h.registry.write(record);

      // Liveness that calls every owner dead shows which records were judged by it.
      const swept = yield* h.registry
        .sweep()
        .pipe(Effect.provideService(OwnerLiveness, () => Effect.succeed("dead")));

      expect(swept).toEqual({ records: 1, socketDirectories: 0 });
      expect(
        Arr.sort(
          Arr.map((yield* h.registry.list()).records, ({ instance }) => instance),
          Order.String,
        ),
      ).toEqual(Arr.sort([answering.instance, refusing.instance], Order.String));
      expect(yield* h.fs.exists(ownerPath)).toBe(true);
    }),
  );

  it.effect("asks about no owner once the time budget passes with probes outstanding", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      yield* h.fs.makeDirectory(h.sockets, { recursive: true });
      const records = Arr.map(["1", "2", "3"], (seed) => h.record(seed));
      const peers = new Set<Socket>();
      const connected = yield* Deferred.make<void>();
      for (const record of records) {
        yield* h.registry.write(record);
        yield* silentListener(record.socket, (peer) => {
          peers.add(peer);
          if (peers.size === records.length) Deferred.doneUnsafe(connected, Effect.void);
        });
      }
      const time = manualClock(yield* Clock.Clock);
      let asked = 0;
      const sweep = yield* h.registry.sweep().pipe(
        Effect.provideService(OwnerLiveness, () =>
          Effect.sync(() => {
            asked += 1;
            return "dead";
          }),
        ),
        Effect.provideService(Clock.Clock, time.clock),
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);

      // Every probe is in flight when the budget runs out; then each fails at once.
      time.advance(2_000);
      for (const peer of peers) peer.destroy();
      const swept = yield* Fiber.join(sweep);

      expect(asked).toBe(0);
      expect(swept.records).toBe(0);
      expect((yield* h.registry.list()).records).toHaveLength(records.length);
    }),
  );

  it.effect("sweeps fallback socket directories only with evidence they are ours and dead", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const own = currentProcessIdentity();
      yield* h.fs.makeDirectory(h.namespace, { mode: 0o700 });
      const socketDirectory = (name: string, owner?: string, extra: Array<string> = []) =>
        Effect.gen(function* () {
          const directory = h.paths.join(h.namespace, name);
          yield* h.fs.makeDirectory(directory, { mode: 0o700 });
          yield* h.fs.writeFileString(h.paths.join(directory, "intercom.sock"), "socket");
          for (const file of extra)
            yield* h.fs.writeFileString(h.paths.join(directory, file), "other");
          if (owner !== undefined) {
            const path = h.paths.join(directory, "owner.json");
            yield* h.fs.writeFileString(path, owner);
            yield* h.fs.chmod(path, 0o600);
          }
          return directory;
        });
      const deadPid = yield* exitedPid;
      const live = yield* socketDirectory(
        hex("1", 16),
        yield* encodeOwner(hex("1", 16), own.pid, own.started),
      );
      const dead = yield* socketDirectory(
        hex("2", 16),
        yield* encodeOwner(hex("2", 16), deadPid, "x"),
      );
      const starting = yield* socketDirectory(hex("3", 16));
      const abandoned = yield* socketDirectory(hex("4", 16));
      yield* ancient(h.fs, abandoned);
      const tombstone = yield* socketDirectory(
        `${hex("5", 16)}.${hex("0", 8)}.tombstone`,
        yield* encodeOwner(hex("5", 16), deadPid, "x"),
      );
      // An owner record naming another instance proves nothing about this directory.
      const mismatched = yield* socketDirectory(
        hex("6", 16),
        yield* encodeOwner(hex("7", 16), deadPid, "x"),
      );
      // Only the entries a socket directory holds are removed; anything else keeps it.
      const cluttered = yield* socketDirectory(
        hex("8", 16),
        yield* encodeOwner(hex("8", 16), deadPid, "x"),
        ["notes.txt"],
      );
      // A link named like a socket directory is never followed.
      const target = h.paths.join(h.fallbackRoot, "target");
      yield* h.fs.makeDirectory(target);
      yield* h.fs.writeFileString(
        h.paths.join(target, "owner.json"),
        yield* encodeOwner(hex("9", 16), deadPid, "x"),
      );
      yield* h.fs.symlink(target, h.paths.join(h.namespace, hex("9", 16)));
      const unrelated = h.paths.join(h.namespace, "unrelated");
      yield* h.fs.makeDirectory(unrelated);

      const swept = yield* h.registry.sweep();

      expect(swept.socketDirectories).toBe(3);
      for (const kept of [live, starting, mismatched]) expect(yield* h.fs.exists(kept)).toBe(true);
      for (const removed of [dead, abandoned, tombstone])
        expect(yield* h.fs.exists(removed)).toBe(false);
      expect(yield* h.fs.readDirectory(target)).toEqual(["owner.json"]);
      expect(yield* h.fs.exists(unrelated)).toBe(true);
      const remaining = yield* h.fs.readDirectory(h.namespace);
      const claimed = Option.getOrUndefined(
        Arr.findFirst(remaining, (name) =>
          Fn.pipe(name, Str.startsWith(`${h.paths.basename(cluttered)}.`)),
        ),
      );
      expect(claimed).toBeDefined();
      expect(
        Arr.sort(yield* h.fs.readDirectory(h.paths.join(h.namespace, claimed ?? "")), Order.String),
      ).toEqual(["intercom.sock", "notes.txt", "owner.json"]);
    }),
  );

  it.effect("sweeps nothing in a fallback namespace that is a link", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const elsewhere = h.paths.join(h.fallbackRoot, "elsewhere");
      const victim = h.paths.join(elsewhere, hex("1", 16));
      yield* h.fs.makeDirectory(victim, { recursive: true });
      yield* h.fs.writeFileString(
        h.paths.join(victim, "owner.json"),
        yield* Schema.encodeEffect(SocketOwnerFromJson)(
          socketOwner(hex("1", 16), yield* exitedPid, "x"),
        ),
      );
      yield* h.fs.chmod(h.paths.join(victim, "owner.json"), 0o600);
      yield* h.fs.symlink(elsewhere, h.namespace);

      const swept = yield* h.registry.sweep();

      expect(swept.socketDirectories).toBe(0);
      expect(yield* h.fs.exists(victim)).toBe(true);
    }),
  );

  it.effect("reserves the socket in the private socket directory when its path fits", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness();
      const instance = hex("9", 16);

      const socket = yield* h.registry.reserveSocket(instance, currentProcessIdentity());

      expect(socket).toBe(h.paths.join(h.sockets, `${instance}.sock`));
      expect(yield* permissions(h.fs, h.sockets)).toBe(0o700);
      expect(yield* h.fs.readDirectory(h.fallbackRoot)).toEqual([]);
    }),
  );

  it.effect("falls back to this user's private namespace when the socket path is too long", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness({ longAgentDirectory: true });
      const instance = hex("a", 16);
      const scope = yield* Scope.make();

      const socket = yield* h.registry
        .reserveSocket(instance, currentProcessIdentity())
        .pipe(Scope.provide(scope));

      const directory = h.paths.dirname(socket);
      expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
      expect(directory).toBe(h.paths.join(h.namespace, instance));
      expect(yield* permissions(h.fs, h.namespace)).toBe(0o700);
      expect(yield* permissions(h.fs, directory)).toBe(0o700);
      const ownerPath = h.paths.join(directory, "owner.json");
      expect(yield* permissions(h.fs, ownerPath)).toBe(0o600);
      expect(
        yield* Schema.decodeEffect(SocketOwnerFromJson)(yield* h.fs.readFileString(ownerPath)),
      ).toMatchObject({ instance, pid: process.pid });

      yield* Scope.close(scope, Exit.void);
      expect(yield* h.fs.exists(directory)).toBe(false);
      expect(yield* h.fs.exists(h.namespace)).toBe(true);
    }),
  );

  it.effect("refuses a fallback namespace that is a link", () =>
    Effect.gen(function* () {
      const h = yield* registryHarness({ longAgentDirectory: true });
      const elsewhere = h.paths.join(h.fallbackRoot, "elsewhere");
      yield* h.fs.makeDirectory(elsewhere, { mode: 0o755 });
      yield* h.fs.symlink(elsewhere, h.namespace);

      const failure = yield* Effect.flip(
        h.registry.reserveSocket(hex("b", 16), currentProcessIdentity()),
      );

      expect(failure.operation).toBe("reserve");
      expect(yield* h.fs.readDirectory(elsewhere)).toEqual([]);
    }),
  );
});
