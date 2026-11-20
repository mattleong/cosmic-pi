import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { manageEffectRuntime, piHostFileLoggerLayer } from "pi-cosmic-core/runtime";
import { backgroundTaskOwnerLayer } from "../layer.ts";
import type { BackgroundTaskNotice, BackgroundTaskProjection } from "../task/model.ts";
import { type BackgroundTaskService, TaskCallerSignal } from "../task/service.ts";

type TaskHost = {
  readonly publish: (projection: BackgroundTaskProjection) => void;
  readonly notify: (notice: BackgroundTaskNotice) => void;
};

/** This scope owns task monitors, not Pi's API, UI, or the lifetime of any caller. */
export function taskOwner() {
  let host: TaskHost | undefined;
  let latest: BackgroundTaskProjection = { tasks: [] };
  // Only already admitted tasks can finish while detached. Their pending notices are bounded by
  // task capacity; don't tie notice ownership to retention of the finished task's registry row.
  const pending: BackgroundTaskNotice[] = [];
  const runtime = manageEffectRuntime(
    ManagedRuntime.make(
      backgroundTaskOwnerLayer({
        publish: (projection) => {
          latest = projection;
          host?.publish(projection);
        },
        notify: (notice) => {
          if (host) host.notify(notice);
          else pending.push(notice);
        },
      }).pipe(
        Layer.provide(
          piHostFileLoggerLayer({ agentDirectory: getAgentDir, packageName: "pi-background-task" }),
        ),
      ),
    ),
  );
  return {
    run: <A, E>(
      effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>,
      signal: AbortSignal,
    ) => runtime.run(effect.pipe(Effect.provideService(TaskCallerSignal, signal)), signal),
    attach: (next: TaskHost) => {
      host = next;
      next.publish(latest);
      for (const notice of pending.splice(0)) {
        if (host !== next) break;
        next.notify({
          ...notice,
          retained: Arr.some(latest.tasks, (task) => task.id === notice.task.id),
        });
      }
    },
    detach: () => {
      host = undefined;
    },
    dispose: runtime.dispose,
  };
}

export type TaskOwner = ReturnType<typeof taskOwner>;

type SessionManager = ExtensionContext["sessionManager"];

export interface TaskSessionKey {
  readonly manager: SessionManager;
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export const taskSessionKey = (
  ctx: ExtensionContext,
  cwd: string,
  projectTrusted: boolean,
): TaskSessionKey | undefined =>
  invokeHostCallback(() => {
    const manager = ctx.sessionManager;
    const sessionId = manager?.getSessionId();
    return Predicate.isString(sessionId) && sessionId.length > 0
      ? { manager, sessionId, cwd, projectTrusted }
      : undefined;
  }, undefined);

interface ParkedOwner {
  readonly owner: TaskOwner;
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly cancelExpiry: () => void;
}

declare global {
  // Pi may reload this module. A process-local, versioned lease transfers live capabilities,
  // never commands or PIDs reconstructed from session history.
  var piBackgroundTaskReloadOwnersV1: WeakMap<SessionManager, ParkedOwner> | undefined;
}

const RELOAD_LEASE_MS = 30_000;

const take = (manager: SessionManager) => {
  const leases = globalThis.piBackgroundTaskReloadOwnersV1;
  const parked = leases?.get(manager);
  if (!parked) return undefined;
  leases?.delete(manager);
  parked.cancelExpiry();
  return parked;
};

const closeParked = (owner: TaskOwner): Promise<void> => owner.dispose().catch(() => undefined);

export const parkTaskOwner = (key: TaskSessionKey, owner: TaskOwner): void => {
  const { manager, sessionId, cwd, projectTrusted } = key;
  const previous = take(manager);
  if (previous) previous.owner.dispose().catch(() => undefined);
  const leases = (globalThis.piBackgroundTaskReloadOwnersV1 ??= new WeakMap());
  // The lease doesn't keep an otherwise idle host alive. Claiming it removes the listener.
  const expiry = AbortSignal.timeout(RELOAD_LEASE_MS);
  const expire = () => {
    if (leases.get(manager) === parked) {
      leases.delete(manager);
      owner.dispose().catch(() => undefined);
    }
  };
  const parked: ParkedOwner = {
    sessionId,
    cwd,
    projectTrusted,
    owner,
    cancelExpiry: () => expiry.removeEventListener("abort", expire),
  };
  leases.set(manager, parked);
  // oxlint-disable-next-line anti-slop/no-manual-abort-listener -- This is an unrefed expiry timer, not cancellation forwarding.
  expiry.addEventListener("abort", expire, { once: true });
};

export const takeTaskOwner = (key: TaskSessionKey, reload: boolean) => {
  const parked = take(key.manager);
  if (!parked) return {};
  if (
    reload &&
    parked.sessionId === key.sessionId &&
    parked.cwd === key.cwd &&
    parked.projectTrusted === key.projectTrusted
  )
    return { owner: parked.owner };
  return { cleanup: closeParked(parked.owner) };
};
