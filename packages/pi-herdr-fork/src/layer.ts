import * as Layer from "effect/Layer";
import type { HerdrForkLinkStore } from "./boundary/host-link-store.ts";
import type { HerdrForkSessionInput } from "./boundary/host-session.ts";
import { HerdrForkService, makeHerdrForkService } from "./fork/service.ts";

export interface HerdrForkLayerInput extends HerdrForkSessionInput {
  readonly linkStore: HerdrForkLinkStore;
}

/** Session-scoped composition root for the fork command service. */
export const makeHerdrForkLayer = (input: HerdrForkLayerInput) =>
  Layer.effect(HerdrForkService, makeHerdrForkService(input, input.linkStore));
