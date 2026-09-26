import * as Effect from "effect/Effect";
import { freezeSnapshot } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import {
  McpPromptMetadataSchema,
  McpResourceMetadataSchema,
  McpTemplateMetadataSchema,
  McpToolMetadataSchema,
  type McpDiscoveryDiagnostic,
} from "./model.ts";
import { listMetadata, metadataBudget } from "./pagination.ts";
import { isToolAllowed } from "./policy.ts";
import { metadataTime } from "./freshness.ts";
import { scanParameterHeaders } from "../invocation/parameter-headers.ts";

/** Prepare all families under one owner and budget; only the service may publish the revision. */
export const collectMetadata = (operation: McpOperation) =>
  Effect.gen(function* () {
    const budget = metadataBudget();
    const tools = operation.capabilities.tools
      ? yield* listMetadata(
          operation,
          "tools.list",
          "tools",
          McpToolMetadataSchema,
          (entry) => entry.name,
          budget,
        )
      : undefined;
    const resources = operation.capabilities.resources
      ? yield* listMetadata(
          operation,
          "resources.list",
          "resources",
          McpResourceMetadataSchema,
          (entry) => entry.uri,
          budget,
        )
      : undefined;
    const templates = operation.capabilities.resources
      ? yield* listMetadata(
          operation,
          "resources.templates",
          "resourceTemplates",
          McpTemplateMetadataSchema,
          (entry) => entry.uriTemplate,
          budget,
        )
      : undefined;
    const prompts = operation.capabilities.prompts
      ? yield* listMetadata(
          operation,
          "prompts.list",
          "prompts",
          McpPromptMetadataSchema,
          (entry) => entry.name,
          budget,
        )
      : undefined;
    const diagnostics: Array<McpDiscoveryDiagnostic> = [];
    let expiresAt = Number.POSITIVE_INFINITY;
    let cacheScope: "public" | "private" = "public";
    for (const [family, listing] of [
      ["tools", tools],
      ["resources", resources],
      ["templates", templates],
      ["prompts", prompts],
    ] as const) {
      if (listing?.supported === false) diagnostics.push({ family, reason: listing.reason });
      if (listing?.supported) {
        expiresAt = Math.min(expiresAt, listing.expiresAt);
        if (listing.cacheScope === "private") cacheScope = "private";
      }
    }
    if (!Number.isFinite(expiresAt)) {
      expiresAt = yield* metadataTime;
      cacheScope = "private";
    }
    const permitted = (tools?.entries ?? []).filter((entry) =>
      isToolAllowed(operation.server, entry.name),
    );
    const accepted =
      operation.capabilities.parameterHeaders === true
        ? permitted.filter((entry) => scanParameterHeaders(entry.inputSchema).valid)
        : permitted;
    if (accepted.length !== permitted.length)
      diagnostics.push({ family: "tools", reason: "invalid-parameter-headers" });
    return yield* Effect.try({
      try: () =>
        freezeSnapshot({
          tools: accepted,
          expiresAt,
          cacheScope,
          resources: resources?.entries ?? [],
          templates: templates?.entries ?? [],
          prompts: prompts?.entries ?? [],
          support: {
            tools: tools?.supported ?? false,
            resources: resources?.supported ?? false,
            templates: templates?.supported ?? false,
            prompts: prompts?.supported ?? false,
          },
          diagnostics,
        }),
      catch: () =>
        boundaryError("output-limit", "not-sent", "Unable to prepare MCP metadata snapshot."),
    });
  });
