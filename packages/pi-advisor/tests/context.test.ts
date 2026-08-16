import { describe, expect, test } from "vitest";
import {
  ADVISOR_CONTEXT_TRUNCATION_MARKER,
  buildAdvisorContext,
  buildAdvisorTranscript,
  DEFAULT_MAX_CONTEXT_CHARS,
} from "../src/review/context.ts";

function text(value: string) {
  return { type: "text", text: value };
}

describe("buildAdvisorContext", () => {
  test("labels in-progress checkpoints without changing final-response defaults", () => {
    const messages = [{ role: "user", content: "Do the work" }];

    expect(
      buildAdvisorContext({ messages, candidate: "Working", phase: "progress" }).transcript,
    ).toContain("Current work checkpoint:\n\nWorking");
    expect(buildAdvisorContext({ messages, candidate: "Done" }).transcript).toContain(
      "Candidate response:\n\nDone",
    );
  });

  test("selects recent context newest-first and renders it oldest-to-newest", () => {
    const candidate = "The implementation is complete.";
    const result = buildAdvisorContext({
      candidate,
      messages: [
        { role: "system", content: "SYSTEM PROMPT MUST NOT APPEAR" },
        { role: "user", content: "An older request" },
        { role: "assistant", content: [text("An older answer")] },
        {
          role: "custom",
          customType: "advisor-review",
          content: "A previous advisor critique",
        },
        {
          role: "custom",
          customType: "project-note",
          content: "Relevant extension context",
        },
        {
          role: "user",
          content: [
            text("Implement the requested change"),
            { type: "image", mimeType: "image/png", data: "SECRET_IMAGE_BYTES" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE_REASONING" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          content: [text("export const answer = 42;")],
        },
        { role: "assistant", content: [text(candidate)] },
      ],
    });

    expect(result.truncated).toBe(false);
    expect(result.transcript).toContain("Latest user request:\n\nImplement the requested change");
    expect(result.transcript).toContain("[image: image/png omitted]");
    expect(result.transcript).toContain("Candidate response:\n\nThe implementation is complete.");
    expect(result.transcript.match(/The implementation is complete\./g)).toHaveLength(1);
    expect(result.transcript).toContain('[tool call: read {"path":"src/a.ts"}]');
    expect(result.transcript).toContain("[tool result: read]\nexport const answer = 42;");
    expect(result.transcript).toContain("[extension context: project-note]");
    expect(result.transcript).toContain("Recent context (oldest to newest):");
    expect(result.transcript).not.toContain("A previous advisor critique");
    expect(result.transcript).not.toContain("SYSTEM PROMPT MUST NOT APPEAR");
    expect(result.transcript).toContain("[assistant thinking]\nPRIVATE_REASONING");
    expect(result.transcript).not.toContain("SECRET_IMAGE_BYTES");
    expect(result.transcript.indexOf("[tool call: read")).toBeLessThan(
      result.transcript.indexOf("[tool result: read]"),
    );
  });

  test("preserves exposed and opaque thinking markers while redacting credentials", () => {
    const result = buildAdvisorContext({
      candidate: "done",
      messages: [
        { role: "user", content: "Use api_key=secret-value" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "visible reasoning" },
            { type: "thinking", signature: "opaque-signature" },
          ],
        },
      ],
    });

    expect(result.transcript).toContain("visible reasoning");
    expect(result.transcript).toContain("opaque/redacted signature");
    expect(result.transcript).not.toContain("secret-value");
    expect(result.transcript).not.toContain("opaque-signature");
  });

  test("recursively redacts credentials inside assistant tool-call arguments", () => {
    const result = buildAdvisorContext({
      candidate: "done",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              arguments: { headers: { authorization: "Bearer nested-secret" } },
            },
          ],
        },
      ],
    });
    expect(result.transcript).not.toContain("nested-secret");
    expect(result.transcript).toContain("REDACTED");
  });

  test("fills a bounded transcript with newest context and marks omitted history", () => {
    const result = buildAdvisorContext({
      maxChars: 520,
      candidate: "CANDIDATE_KEPT",
      messages: [
        { role: "user", content: `OLDEST_CONTEXT_${"o".repeat(500)}` },
        { role: "assistant", content: [text(`MIDDLE_CONTEXT_${"m".repeat(500)}`)] },
        { role: "user", content: "LATEST_REQUEST_KEPT" },
        {
          role: "toolResult",
          toolName: "read",
          isError: false,
          content: [text(`NEWEST_CONTEXT_${"n".repeat(500)}`)],
        },
        { role: "assistant", content: [text("CANDIDATE_KEPT")] },
      ],
    });

    expect(result.transcript.length).toBeLessThanOrEqual(520);
    expect(result.transcript).toContain("CANDIDATE_KEPT");
    expect(result.transcript).toContain("LATEST_REQUEST_KEPT");
    expect(result.transcript).toContain("NEWEST_CONTEXT_");
    expect(result.transcript).not.toContain("OLDEST_CONTEXT_");
    expect(result.transcript).toContain(ADVISOR_CONTEXT_TRUNCATION_MARKER);
    expect(result.truncated).toBe(true);
    expect(result.omittedHistoryMessageCount).toBeGreaterThan(0);
  });

  test("renders admitted tool context chronologically without changing newest-first admission", () => {
    const result = buildAdvisorContext({
      maxChars: 350,
      candidate: "candidate",
      messages: [
        { role: "assistant", content: [text(`OLDEST_${"o".repeat(80)}`)] },
        { role: "assistant", content: [text(`MIDDLE_${"m".repeat(80)}`)] },
        { role: "user", content: "LATEST_REQUEST" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-recent",
              name: "read",
              arguments: { path: "src/recent.ts" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-recent",
          toolName: "read",
          content: [text(`NEWEST_RESULT_${"n".repeat(80)}`)],
        },
        { role: "assistant", content: [text("candidate")] },
      ],
    });

    expect(result.transcript.length).toBeLessThanOrEqual(350);
    expect(result.includedHistoryMessageCount).toBe(2);
    expect(result.omittedHistoryMessageCount).toBe(2);
    expect(result.transcript).not.toContain("OLDEST_");
    expect(result.transcript).not.toContain("MIDDLE_");
    expect(result.transcript.indexOf("[tool call: read")).toBeLessThan(
      result.transcript.indexOf("[tool result: read]"),
    );
  });

  test("shortens oversized required sections while retaining both ends and the hard cap", () => {
    const candidate = `CANDIDATE_START_${"c".repeat(1_000)}_CANDIDATE_END`;
    const request = `REQUEST_START_${"r".repeat(1_000)}_REQUEST_END`;
    const result = buildAdvisorContext({
      maxChars: 600,
      candidate,
      messages: [{ role: "user", content: request }],
    });

    expect(result.transcript.length).toBeLessThanOrEqual(600);
    expect(result.transcript).toContain("CANDIDATE_START_");
    expect(result.transcript).toContain("_CANDIDATE_END");
    expect(result.transcript).toContain("REQUEST_START_");
    expect(result.transcript).toContain("_REQUEST_END");
    expect(result.transcript).toContain(ADVISOR_CONTEXT_TRUNCATION_MARKER);
    expect(result.truncated).toBe(true);
  });

  test("uses the 240k default and exposes a transcript-only convenience helper", () => {
    expect(DEFAULT_MAX_CONTEXT_CHARS).toBe(240_000);
    const options = {
      candidate: "candidate",
      messages: [
        { role: "user", content: "request" },
        { role: "toolResult", toolName: "large", content: [text("x".repeat(300_000))] },
      ],
    };
    const result = buildAdvisorContext(options);

    expect(result.transcript.length).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_CHARS);
    expect(buildAdvisorTranscript(options)).toBe(result.transcript);
    expect(result.truncated).toBe(true);
  });
});
