import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpSettings } from "../config/model.ts";

export interface AdmissionTicket {
  readonly id: number;
  readonly server: string;
  readonly deadline: number;
  readonly revoked: Deferred.Deferred<never, McpBoundaryError>;
  current: boolean;
  outcome: McpBoundaryError["outcome"];
}
interface AdmissionSnapshot {
  readonly active: number;
  readonly queued: number;
}
interface DispatchWaiter {
  readonly ticket: AdmissionTicket;
  readonly ready: Deferred.Deferred<void, McpBoundaryError>;
  state: "queued" | "active" | "released";
}

/** All methods run under the registry lock. No I/O or wait is performed here. */
export class McpAdmission {
  private nextId = 0;
  private readonly tickets = new Map<number, AdmissionTicket>();
  private readonly dependencies = new Set<number>();
  private readonly waiting: Array<DispatchWaiter> = [];
  private readonly dispatches = new Set<DispatchWaiter>();
  private readonly perServer = new Map<string, number>();
  private readonly settings: () => McpSettings;
  private readonly changed: () => void;
  constructor(settings: () => McpSettings, changed: () => void = () => undefined) {
    this.settings = settings;
    this.changed = changed;
  }

  issue(server: string, now: number): AdmissionTicket | McpBoundaryError {
    return this.allocate(server, now, false);
  }

  /** Shared prerequisites have a separate bounded population, not a second caller charge.
   * They still use the same remote permits and the exact configured dispatch queue. */
  issueDependency(server: string, now: number): AdmissionTicket | McpBoundaryError {
    return this.allocate(server, now, true);
  }

  private allocate(
    server: string,
    now: number,
    dependency: boolean,
  ): AdmissionTicket | McpBoundaryError {
    const settings = this.settings();
    const count = dependency ? this.dependencies.size : this.tickets.size - this.dependencies.size;
    if (count >= settings.maxConcurrent + settings.maxQueued) {
      return boundaryError("busy", "not-sent", "MCP operation capacity is exhausted.");
    }
    const ticket: AdmissionTicket = {
      id: ++this.nextId,
      server,
      deadline: now + settings.requestTimeoutMs,
      revoked: Deferred.makeUnsafe(),
      current: true,
      outcome: "not-sent",
    };
    this.tickets.set(ticket.id, ticket);
    if (dependency) this.dependencies.add(ticket.id);
    this.changed();
    return ticket;
  }

  release(ticket: AdmissionTicket): void {
    ticket.current = false;
    this.tickets.delete(ticket.id);
    this.dependencies.delete(ticket.id);
    // finish mutates the queue, so iterate a stable copy.
    for (const waiter of this.waiting.slice()) {
      if (waiter.ticket === ticket) this.finish(waiter);
    }
    this.pump();
  }

  cancel(ticket: AdmissionTicket): void {
    ticket.current = false;
    Deferred.doneUnsafe(ticket.revoked, Effect.fail(this.stale(ticket)));
  }

  revoke(server?: string): void {
    for (const ticket of this.tickets.values()) {
      if (server !== undefined && ticket.server !== server) continue;
      this.cancel(ticket);
    }
    // finish mutates the queue, so iterate a stable copy.
    for (const waiter of this.waiting.slice()) {
      if (!waiter.ticket.current) this.finish(waiter);
    }
    this.pump();
  }

  enqueue(ticket: AdmissionTicket): DispatchWaiter {
    const waiter: DispatchWaiter = { ticket, ready: Deferred.makeUnsafe(), state: "queued" };
    if (!ticket.current) {
      waiter.state = "released";
      Deferred.doneUnsafe(waiter.ready, Effect.fail(this.stale(ticket)));
    } else {
      this.waiting.push(waiter);
      this.pump();
      if (waiter.state === "queued" && this.waiting.length > this.settings().maxQueued) {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        waiter.state = "released";
        Deferred.doneUnsafe(
          waiter.ready,
          Effect.fail(boundaryError("busy", "not-sent", "MCP dispatch queue is full.")),
        );
      }
    }
    return waiter;
  }

  finish(waiter: DispatchWaiter): void {
    if (waiter.state === "released") return;
    if (waiter.state === "active") {
      this.dispatches.delete(waiter);
      const count = (this.perServer.get(waiter.ticket.server) ?? 1) - 1;
      if (count === 0) this.perServer.delete(waiter.ticket.server);
      else this.perServer.set(waiter.ticket.server, count);
    } else {
      const index = this.waiting.indexOf(waiter);
      if (index !== -1) this.waiting.splice(index, 1);
      Deferred.doneUnsafe(waiter.ready, Effect.fail(this.stale(waiter.ticket)));
    }
    waiter.state = "released";
    this.pump();
  }

  snapshot(server?: string): AdmissionSnapshot {
    return server === undefined
      ? { active: this.dispatches.size, queued: this.waiting.length }
      : {
          active: this.perServer.get(server) ?? 0,
          queued: this.waiting.filter((waiter) => waiter.ticket.server === server).length,
        };
  }

  operations(server: string): number {
    return [...this.tickets.values()].filter((ticket) => ticket.server === server && ticket.current)
      .length;
  }

  private stale(ticket: AdmissionTicket): McpBoundaryError {
    return boundaryError("stale", ticket.outcome, "MCP operation authority was revoked.");
  }

  /** FIFO among eligible servers. A saturated server cannot block unrelated capacity. */
  private pump(): void {
    this.changed();
    const settings = this.settings();
    for (
      let index = 0;
      index < this.waiting.length && this.dispatches.size < settings.maxConcurrent;
    ) {
      const waiter = this.waiting[index]!;
      if (!waiter.ticket.current) {
        this.waiting.splice(index, 1);
        waiter.state = "released";
        Deferred.doneUnsafe(waiter.ready, Effect.fail(this.stale(waiter.ticket)));
        continue;
      }
      const count = this.perServer.get(waiter.ticket.server) ?? 0;
      if (count >= settings.maxPerServer) {
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      waiter.state = "active";
      this.dispatches.add(waiter);
      this.perServer.set(waiter.ticket.server, count + 1);
      Deferred.doneUnsafe(waiter.ready, Effect.void);
    }
  }
}
