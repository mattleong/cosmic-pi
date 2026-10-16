import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESPONSES = 8;

// Answers every request with the latest user text, so an RPC test can see which input ran.
const echoLatestUserText: FauxResponseFactory = (context) => {
  const latest = context.messages.findLast((message) => message.role === "user");
  const text =
    latest === undefined
      ? ""
      : Array.isArray(latest.content)
        ? latest.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        : latest.content;
  return fauxAssistantMessage(`echo: ${text}`);
};

export default function rpcFauxFixture(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "rpc-faux", tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: RESPONSES }, () => echoLatestUserText));
  pi.registerProvider(faux.provider);
  pi.on("session_start", (_event, ctx) =>
    // Registration queues auth discovery; settle it before selecting the offline provider.
    ctx.modelRegistry.refresh({ providers: ["rpc-faux"], allowNetwork: false }).then(() => {
      const expected = faux.getModel();
      const model = ctx.modelRegistry.find(expected.provider, expected.id);
      if (model === undefined) throw new Error("Offline RPC fixture model was not registered.");
      return pi.setModel(model).then((selected) => {
        if (!selected) throw new Error("Offline RPC fixture model was not selected.");
        return undefined;
      });
    }),
  );
  pi.registerCommand("fixture-shutdown", {
    description: "Stop the offline RPC fixture",
    handler: (_args, ctx) => {
      ctx.shutdown();
      return Promise.resolve();
    },
  });
}
