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
  pi.on("session_start", () => pi.setModel(faux.getModel()).then(() => undefined));
  pi.registerCommand("fixture-shutdown", {
    description: "Stop the offline RPC fixture",
    handler: (_args, ctx) => {
      ctx.shutdown();
      return Promise.resolve();
    },
  });
}
