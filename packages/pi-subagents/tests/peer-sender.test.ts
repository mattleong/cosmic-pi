// Node socket behavior is characterized at this owned transport boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  PeerSendNotAttemptedError,
  supervisorChannelTesting,
} from "../src/boundary/supervisor-channel.ts";
import {
  authenticateSupervisorServerPayload,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAuthTokenSchema,
  SupervisorRunIdSchema,
} from "../src/supervisor/protocol.ts";

const message = authenticateSupervisorServerPayload(
  {
    version: SUPERVISOR_CHANNEL_VERSION,
    runId: SupervisorRunIdSchema.make("agent-peer-sender"),
    token: SupervisorAuthTokenSchema.make("a".repeat(64)),
  },
  { type: "closed" },
);

const socketFixture = (destroyed: boolean): Socket => {
  const socket: Socket = Object.assign(Object.create(Socket.prototype), { write: () => true });
  Object.defineProperty(socket, "destroyed", { value: destroyed });
  return socket;
};

describe("supervisor peer sender", () => {
  it("keeps a live peer available when its bounded write backlog is full", async () => {
    let failures = 0;
    const send = supervisorChannelTesting.makePeerSender(socketFixture(false), () => failures++);
    for (let index = 0; index < 32; index++) void send(message).catch(() => undefined);

    await expect(send(message)).rejects.toMatchObject({
      _tag: "PeerSendNotAttemptedError",
      reason: "unavailable",
    } satisfies Partial<PeerSendNotAttemptedError>);
    expect(failures).toBe(0);
  });

  it("closes a peer that was already unavailable before the write", async () => {
    let failures = 0;
    const send = supervisorChannelTesting.makePeerSender(socketFixture(true), () => failures++);

    await expect(send(message)).rejects.toBeInstanceOf(PeerSendNotAttemptedError);
    expect(failures).toBe(1);
  });
});
