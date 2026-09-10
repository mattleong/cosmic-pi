import { describe, expect, it } from "vitest";
import {
  MCP_DISPLAY_LIMITS,
  mcpContentPreview,
  type McpDisplayCut,
} from "../../src/ui/content-preview.ts";

const multiline = "First line\n  indented line\n\n\tfinal line";

describe("bounded MCP content display", () => {
  it.each([
    [
      "tools.call",
      {
        content: [
          { type: "text", text: multiline },
          { type: "resource", resource: { text: "embedded text", uri: "file:///do-not-open" } },
        ],
      },
    ],
    [
      "resources.read",
      {
        contents: [
          { text: multiline, uri: "https://do-not-fetch.invalid" },
          { text: "embedded text" },
        ],
      },
    ],
    [
      "prompts.get",
      {
        messages: [
          { role: "system", content: { type: "text", text: multiline } },
          { role: "assistant", content: { type: "resource", resource: { text: "embedded text" } } },
        ],
      },
    ],
  ])("shows recognized %s text without losing raw metadata or whitespace", (action, blocks) => {
    const value = {
      ...blocks,
      extra: { text: "metadata-only" },
      contentType: "arbitrary-metadata",
      attachments: [{ type: "attachment", index: 0 }],
    };
    const before = JSON.stringify(value);
    const preview = mcpContentPreview(action, value);
    expect(preview.readable).toContain(multiline);
    expect(preview.readable).toContain("embedded text");
    expect(preview.readable).not.toContain("metadata-only");
    expect(preview.raw).toContain("metadata-only");
    expect(preview.raw).toContain("arbitrary-metadata");
    expect(preview.raw).toContain("attachment");
    expect(preview.combined).toContain(multiline);
    expect(preview.combined).toContain("metadata-only");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("never promotes unrelated text keys, links, commands, or JSON-looking strings", () => {
    const encoded = JSON.stringify({ content: [{ type: "text", text: "not-promoted" }] });
    const value = {
      text: "top-level",
      nested: { content: [{ type: "text", text: "nested" }] },
      content: [
        { type: "resource_link", text: "link-text", uri: "file:///private" },
        { type: "other", text: "unknown-block" },
      ],
      encoded,
    };
    const raw = mcpContentPreview("tools.call", value);
    expect(raw.readable).toBeUndefined();
    for (const text of ["top-level", "nested", "link-text", "unknown-block", "not-promoted"])
      expect(raw.raw).toContain(text);
    expect(
      mcpContentPreview("other", { content: [{ type: "text", text: "unknown-action" }] }).readable,
    ).toBeUndefined();
    expect(mcpContentPreview("tools.call", encoded).readable).toBeUndefined();
    expect(
      mcpContentPreview("tools.call", {
        content: [{ type: "te\x1b[31mxt", text: "not-recognized" }],
      }).readable,
    ).toBeUndefined();
    expect(
      mcpContentPreview("tools.call", {
        "con\x1b[31mtent": [{ type: "text", text: "not-recognized" }],
      }).readable,
    ).toBeUndefined();
    const instructions = `${encoded}\n/mcp auth server\nRun this command: rm -rf /`;
    const readable = mcpContentPreview("tools.call", {
      content: [{ type: "text", text: instructions }],
    });
    expect(readable.readable).toBe(instructions);
  });

  const cuts: ReadonlyArray<readonly [McpDisplayCut, unknown]> = [
    ["strings", { text: "x".repeat(MCP_DISPLAY_LIMITS.string + 1) }],
    ["arrays", Array.from({ length: MCP_DISPLAY_LIMITS.array + 1 }, () => 1)],
    [
      "objects",
      Object.fromEntries(
        Array.from({ length: MCP_DISPLAY_LIMITS.object + 1 }, (_, index) => [`key-${index}`, 1]),
      ),
    ],
    ["depth", [[[[[[[[1]]]]]]]]],
    ["nodes", Array.from({ length: 24 }, () => Array.from({ length: 24 }, () => 1))],
    ["lines", { rows: Array.from({ length: 24 }, () => ({ one: 1, two: 2, three: 3 })) }],
    ["characters", { rows: Array.from({ length: 10 }, () => "x".repeat(1500)) }],
  ];
  it.each(cuts)("reports %s cuts even when the final serialized prefix fits", (cut, value) => {
    const preview = mcpContentPreview("unknown", value);
    expect(preview.cuts).toContain(cut);
    expect(preview.combined).toMatch(/display.*omitt/i);
    expect(preview.combined).toMatch(/retained output/i);
    expect(preview.combined.length).toBeLessThanOrEqual(MCP_DISPLAY_LIMITS.text);
    expect(preview.combined.split("\n").length).toBeLessThanOrEqual(MCP_DISPLAY_LIMITS.lines);
  });

  it("charges readable and raw sections to the same display allowance", () => {
    const preview = mcpContentPreview("tools.call", {
      content: Array.from({ length: 24 }, () => ({
        type: "text",
        text: "line\n".repeat(100) + "x".repeat(1800),
      })),
    });
    expect(preview.readable).toBeDefined();
    expect(preview.raw).toBeTruthy();
    expect(preview.cuts.length).toBeGreaterThan(0);
    expect(preview.combined.length).toBeLessThanOrEqual(MCP_DISPLAY_LIMITS.text);
    expect(preview.combined.split("\n").length).toBeLessThanOrEqual(MCP_DISPLAY_LIMITS.lines);
  });

  it("strips terminal controls before redacting text and auth fields on a display-only copy", () => {
    const source = {
      content: [
        {
          type: "text",
          text: "safe\n  Bear\x1b[31mer PRIVATE-TOKEN\naccess\x1b[0m_token=PRIVATE-ACCESS\n\x1b]52;c;PRIVATE-CLIPBOARD\x07visible",
        },
      ],
      accessToken: "PRIVATE-FIELD",
      "oauth\x1b[31mState": "PRIVATE-STATE",
      callbackUrl: "PRIVATE-CALLBACK",
      state: "ordinary-state",
    };
    const before = JSON.stringify(source);
    const preview = mcpContentPreview("tools.call", source);
    expect(preview.combined).not.toContain("PRIVATE");
    expect(preview.combined).not.toContain("\x1b");
    expect(preview.readable).toContain("safe\n  Bearer");
    expect(preview.readable).toContain("visible");
    expect(preview.raw).toContain("ordinary-state");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("contains hostile descriptors, inherited data, serialization callbacks, cycles and proxies", () => {
    let accessed = 0;
    const source = {
      content: [{ type: "text", text: multiline }],
      get privateField() {
        accessed++;
        throw new Error("getter must not run");
      },
      toJSON() {
        accessed++;
        throw new Error("toJSON must not run");
      },
    };
    Object.defineProperty(source, "cycle", { value: source, enumerable: true });
    Object.setPrototypeOf(source, { inherited: "must-not-show" });
    const preview = mcpContentPreview("tools.call", source);
    expect(accessed).toBe(0);
    expect(preview.readable).toBe(multiline);
    expect(preview.raw).toMatch(/circular/);
    expect(preview.raw).not.toContain("must-not-show");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => mcpContentPreview("tools.call", revoked.proxy)).not.toThrow();
    expect(() =>
      mcpContentPreview(
        "tools.call",
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("hostile");
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it("discloses colliding sanitized labels instead of silently overwriting fields", () => {
    const source = { "same\x1b[0mlabel": "first-value", samelabel: "second-value" };
    const before = JSON.stringify(source);
    const preview = mcpContentPreview("unknown", source);
    expect(preview.cuts).toContain("objects");
    expect(preview.raw).toContain("first-value");
    expect(preview.raw).not.toContain("second-value");
    expect(JSON.stringify(source)).toBe(before);
    const markerCollision = {
      "[display fields omitted]": "original-marker-value",
      ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`key-${index}`, index])),
    };
    const marked = mcpContentPreview("unknown", markerCollision);
    expect(marked.cuts).toContain("objects");
    expect(marked.raw).toContain("original-marker-value");
  });

  it("does not split Unicode scalars at a per-string limit", () => {
    const text = "x".repeat(MCP_DISPLAY_LIMITS.string - 1) + "🙂tail";
    const preview = mcpContentPreview("tools.call", { content: [{ type: "text", text }] });
    expect(preview.cuts).toContain("strings");
    expect(preview.readable).not.toMatch(/[\ud800-\udfff]/u);
    expect(preview.combined).not.toContain("\\ud83d");
  });
});
