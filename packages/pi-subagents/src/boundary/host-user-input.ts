import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Returns the signal that the user's next message aborts. Open root waits listen to it, so a
 * message typed during `subagent_await` reaches the parent instead of waiting for the children.
 * Input that other extensions send does not count.
 */
export function registerUserInputSignal(pi: ExtensionAPI): () => AbortSignal {
  let current = new AbortController();
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    current.abort();
    current = new AbortController();
  });
  return () => current.signal;
}
