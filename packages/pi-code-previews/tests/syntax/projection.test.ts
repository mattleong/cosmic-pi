import { describe, expect, it } from "vitest";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";
import {
  clearSyntaxProjection,
  installSyntaxRequests,
  publishSyntaxProjection,
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
  type CodePreviewSyntaxSnapshot,
} from "../../src/syntax/projection";

const snapshot = (theme: string): CodePreviewSyntaxSnapshot => ({
  generation: 0,
  theme,
  highlighter: undefined,
  loadedLanguages: [],
  status: {
    initialized: false,
    loadedLanguages: 0,
    pendingLanguages: 0,
    statusVersion: 0,
  },
});

describe("syntax projection ownership", () => {
  it("routes projection and requests only to the newest overlapping session", () => {
    const stale = acquireProjectionOwnership("syntax-stale");
    const current = acquireProjectionOwnership("syntax-current");
    const calls: string[] = [];
    publishSyntaxProjection(stale, snapshot("stale"));
    installSyntaxRequests(stale, {
      initialize: () => calls.push("stale-initialize"),
      language: () => calls.push("stale-language"),
    });

    publishSyntaxProjection(current, snapshot("current"));
    installSyntaxRequests(current, {
      initialize: () => calls.push("current-initialize"),
      language: () => calls.push("current-language"),
    });
    publishSyntaxProjection(stale, snapshot("late-stale"));
    installSyntaxRequests(stale, {
      initialize: () => calls.push("late-stale-initialize"),
      language: () => calls.push("late-stale-language"),
    });
    clearSyntaxProjection(stale);

    requestSyntaxInitialize("theme");
    requestSyntaxLanguage("typescript");
    expect(syntaxProjection()?.theme).toBe("current");
    expect(calls).toEqual(["current-initialize", "current-language"]);
    clearSyntaxProjection(current);

    publishSyntaxProjection(stale, snapshot("after-current-clear"));
    installSyntaxRequests(stale, {
      initialize: () => calls.push("retired-initialize"),
      language: () => calls.push("retired-language"),
    });
    requestSyntaxInitialize("theme");
    expect(syntaxProjection()).toBeUndefined();
    expect(calls).toEqual(["current-initialize", "current-language"]);
  });

  it("lets a newer owner replace an abandoned owner", () => {
    const abandoned = acquireProjectionOwnership("syntax-abandoned");
    const replacement = acquireProjectionOwnership("syntax-replacement");
    publishSyntaxProjection(abandoned, snapshot("abandoned"));
    publishSyntaxProjection(replacement, snapshot("replacement"));

    expect(syntaxProjection()?.theme).toBe("replacement");
    clearSyntaxProjection(replacement);
  });
});
