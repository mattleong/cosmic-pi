import type { JSONRPCMessage, MessageExtraInfo, Transport } from "@modelcontextprotocol/client";

export interface TransportHooks {
  readonly send: Transport["send"];
  /** Observes inbound traffic first; `false` withholds the message from the SDK. */
  readonly receive?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => boolean | void;
}

/**
 * Wrap the public SDK Transport seam, replacing only `send` and inbound observation.
 * Everything else forwards, including the properties the SDK reads to classify a
 * transport: per-request streams (HTTP) and `pid`/`stderr` (local stdio).
 */
export const decorateTransport = (inner: Transport, hooks: TransportHooks): Transport => {
  const decorated: Transport = {
    get sessionId() {
      return inner.sessionId;
    },
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => inner.setSupportedProtocolVersions?.(versions),
    start: () => inner.start(),
    close: () => inner.close(),
    send: hooks.send,
  };
  if (inner.hasPerRequestStream === true)
    Object.defineProperty(decorated, "hasPerRequestStream", { enumerable: true, value: true });
  if ("pid" in inner && "stderr" in inner)
    Object.defineProperties(decorated, {
      pid: { enumerable: true, get: () => inner.pid },
      stderr: { enumerable: true, get: () => inner.stderr },
    });
  inner.onclose = () => decorated.onclose?.();
  inner.onerror = (error) => decorated.onerror?.(error);
  inner.onmessage = (message, extra) => {
    if (hooks.receive?.(message, extra) !== false) decorated.onmessage?.(message, extra);
  };
  return decorated;
};
