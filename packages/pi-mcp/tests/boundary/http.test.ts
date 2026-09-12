import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpExecution } from "../../src/tools/service.ts";
import { optionalFixture, projection, reply } from "../fixtures/optional-features.ts";

for (const value of ["✓", "=?base64?already?=", "a\u0000b"])
  it.live(
    `actual HTTP sends encoded derived headers without configured-case conflicts: ${JSON.stringify(value)}`,
    () => {
      const name = "✓";
      const fixture = optionalFixture(
        (request) =>
          request.method === "tools/list"
            ? reply(request.id!, {
                tools: [
                  {
                    name,
                    inputSchema: {
                      type: "object",
                      properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } },
                    },
                  },
                ],
              })
            : undefined,
        { headers: { "mCp-PaRaM-TeNaNt": "configured-stale", "mCp-NaMe": "configured-stale" } },
      );
      return Effect.gen(function* () {
        yield* (yield* McpExecution).execute(
          { action: "tools.call", server: "fixture", tool: name, arguments: { tenant: value } },
          projection,
        );
        const index = fixture.requests.findIndex((request) => request.method === "tools/call");
        expect(index).toBeGreaterThanOrEqual(0);
        expect(fixture.headers[index]!.get("mcp-name")).toBe("=?base64?4pyT?=");
        expect(fixture.headers[index]!.get("mcp-param-tenant")).toBe(
          `=?base64?${Buffer.from(value).toString("base64")}?=`,
        );
        expect(fixture.headers[index]!.get("x-pi-mcp-operation")).toBeNull();
      }).pipe(Effect.provide(fixture.layer));
    },
  );

it.live("malformed UTF16 standard identity headers fail before actual dispatch", () => {
  const name = "bad\ud800";
  const fixture = optionalFixture((request) =>
    request.method === "tools/list"
      ? reply(request.id!, { tools: [{ name, inputSchema: { type: "object" } }] })
      : undefined,
  );
  return Effect.gen(function* () {
    expect(
      yield* (yield* McpExecution)
        .execute({ action: "tools.call", server: "fixture", tool: name }, projection)
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "invalid-input", outcome: "not-sent" });
    expect(fixture.requests.some((request) => request.method === "tools/call")).toBe(false);
  }).pipe(Effect.provide(fixture.layer));
});
