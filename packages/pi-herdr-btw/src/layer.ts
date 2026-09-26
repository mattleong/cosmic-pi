import * as Layer from "effect/Layer";
import { HerdrClient } from "./boundary/herdr-client.ts";
import { HerdrBtwService, makeHerdrBtwService } from "./btw/service.ts";

/** Session-scoped composition root for the BTW command service. */
export const makeHerdrBtwLayer = (input: Parameters<typeof makeHerdrBtwService>[0]) =>
  Layer.effect(HerdrBtwService, makeHerdrBtwService(input)).pipe(
    Layer.provide(HerdrClient.layer(input.environment)),
  );
