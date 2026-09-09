import { describe, expect, it } from "vitest";
import { outputTasks } from "../../eval/output-tasks.ts";
import type { EvalTask } from "../../eval/tasks.ts";

const task = (id: string) => outputTasks.find((entry) => entry.id === id)!;
// JSON here is authored fixture data, not host/provider input. Independent graders below
// recompute outcomes from file contents rather than sharing the fixture generation logic.
const rows = (fixture: EvalTask, prefix: string) =>
  Object.entries(fixture.files)
    .filter(([path]) => path.startsWith(prefix) && path.endsWith(".jsonl"))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, text]) =>
      text
        .trim()
        .split("\n")
        .map((line, index) => ({ data: JSON.parse(line), source: { path, line: index + 1 } })),
    );

describe("fresh output-fixture oracles", () => {
  it("checks decisive ordered policy evidence and latest-event tie breaking", () => {
    const policyTask = task("OH1");
    const identities = rows(policyTask, "identities/");
    const policyLines = policyTask.files["policy.txt"]!.trim().split("\n");
    const denied = identities.flatMap(({ data, source }) => {
      const rule = data.suspended ? 0 : data.expired ? 1 : -1;
      return rule < 0
        ? []
        : [
            {
              id: data.id,
              source,
              rule: { path: "policy.txt", line: rule + 1, text: policyLines[rule] },
            },
          ];
    });
    expect({ checked: identities.length, denied }).toEqual(policyTask.expected);
    const historyTask = task("OH2");
    const history = rows(historyTask, "history/");
    const jobs = [...new Set(history.map((entry) => entry.data.job))].sort();
    const stale = jobs.flatMap((job) => {
      const events = history
        .filter((entry) => entry.data.job === job)
        .sort(
          (left, right) =>
            right.data.timestamp - left.data.timestamp || right.data.sequence - left.data.sequence,
        );
      const latest = events[0]!;
      return latest.data.state === "running" && latest.data.timestamp < 220
        ? [
            {
              job,
              timestamp: latest.data.timestamp,
              sequence: latest.data.sequence,
              source: latest.source,
            },
          ]
        : [];
    });
    expect({ checkedJobs: jobs.length, stale }).toEqual(historyTask.expected);
  });
  it("checks missing/mismatched signatures and exact active runbook evidence", () => {
    const release = task("OH3");
    const assets = rows(release, "assets/");
    const signatures = rows(release, "signatures.jsonl");
    const published = assets.filter((entry) => entry.data.published);
    const violations = published.flatMap((asset) => {
      const signature = signatures.find((entry) => entry.data.asset === asset.data.id);
      if (signature?.data.digest === asset.data.digest) return [];
      return [
        {
          id: asset.data.id,
          problem: signature ? "digest-mismatch" : "missing-signature",
          index: asset.source,
          signature: signature?.source ?? null,
        },
      ];
    });
    expect({
      checkedAssets: assets.length,
      publishedAssets: published.length,
      checkedSignatures: signatures.length,
      violations,
    }).toEqual(release.expected);
    const docs = task("OH4");
    let checkedActive = 0;
    const findings: { path: string; line: number; text: string }[] = [];
    for (const [path, text] of Object.entries(docs.files).filter(([path]) =>
      path.startsWith("runbooks/"),
    )) {
      let active = false;
      for (const [index, line] of text.trimEnd().split("\n").entries()) {
        if (line.startsWith("## ")) {
          active = line === "## Active";
          continue;
        }
        if (!active) continue;
        checkedActive++;
        if (!line.includes("backupRetention=14 ") || !line.includes("tlsRequired=true;"))
          findings.push({ path, line: index + 1, text: line });
      }
    }
    expect({ checkedActive, findings }).toEqual(docs.expected);
  });
  it("checks breaking API fields and alias resolution without truthiness defaults", () => {
    const api = task("OH5");
    const before = rows(api, "before/");
    const after = rows(api, "after/");
    const changes = before
      .flatMap((old) => {
        const next = after.find((entry) => entry.data.endpoint === old.data.endpoint)!;
        const fields = Object.keys(old.data.response).flatMap((field) => {
          const removed = !Object.hasOwn(next.data.response, field);
          return removed || old.data.response[field] !== next.data.response[field]
            ? [
                {
                  endpoint: old.data.endpoint,
                  field: `response.${field}`,
                  kind: removed ? "removed" : "type-changed",
                  before: old.data.response[field],
                  after: next.data.response[field] ?? null,
                  beforeSource: old.source,
                  afterSource: next.source,
                },
              ]
            : [];
        });
        for (const field of Object.keys(old.data.request)) {
          if (!old.data.request[field].required && next.data.request[field].required)
            fields.push({
              endpoint: old.data.endpoint,
              field: `request.${field}.required`,
              kind: "made-required",
              before: false,
              after: true,
              beforeSource: old.source,
              afterSource: next.source,
            });
        }
        return fields;
      })
      .sort(
        (left, right) =>
          Number(left.endpoint.split("/").at(-1)) - Number(right.endpoint.split("/").at(-1)),
      );
    expect({ checkedEndpoints: before.length, changes }).toEqual(api.expected);
    const aliasesTask = task("OH6");
    const catalog = JSON.parse(aliasesTask.files["catalog.json"]!);
    const aliases = rows(aliasesTask, "aliases/");
    const conflicts = aliases.flatMap((entry) => {
      let target = entry.data.target;
      const seen = new Set<string>();
      while (target.startsWith("alias-")) {
        if (seen.has(target)) throw new Error("Cyclic fixture alias");
        seen.add(target);
        target = aliases.find((alias) => alias.data.id === target)!.data.target;
      }
      const canonical = catalog.find((item: { id: string }) => item.id === target);
      return Object.keys(entry.data.overrides).flatMap((field) =>
        canonical[field] === entry.data.overrides[field]
          ? []
          : [
              {
                alias: entry.data.id,
                canonical: target,
                field,
                expected: canonical[field],
                actual: entry.data.overrides[field],
                source: entry.source,
              },
            ],
      );
    });
    expect({ checkedAliases: aliases.length, conflicts }).toEqual(aliasesTask.expected);
  });
  it("checks coverage completeness and sparse incident citations across every file", () => {
    const coverageTask = task("OH7");
    const axes = JSON.parse(coverageTask.files["required.json"]!);
    const required: { os: string; db: string; feature: string; mode: string }[] = [];
    for (const os of axes.os)
      for (const db of axes.db)
        for (const feature of axes.feature)
          for (const mode of axes.mode) required.push({ os, db, feature, mode });
    const observations = rows(coverageTask, "observations/");
    const same = (left: (typeof required)[number], right: (typeof required)[number]) =>
      left.os === right.os &&
      left.db === right.db &&
      left.feature === right.feature &&
      left.mode === right.mode;
    const missing = required.filter(
      (combination) =>
        !observations.some(
          (entry) => entry.data.status === "pass" && same(combination, entry.data),
        ),
    );
    expect({
      requiredCombinations: required.length,
      observedRecords: observations.length,
      coveredCombinations: required.length - missing.length,
      ignoredOutOfMatrix: observations.filter(
        (entry) => !required.some((combination) => same(combination, entry.data)),
      ).length,
      missing,
    }).toEqual(coverageTask.expected);
    const incidentsTask = task("OH8");
    const policy = JSON.parse(incidentsTask.files["policy.json"]!);
    let checkedRecords = 0;
    const incidents: { id: number; path: string; line: number; text: string }[] = [];
    for (const [path, content] of Object.entries(incidentsTask.files).filter(([path]) =>
      path.startsWith("incidents/"),
    )) {
      for (const [index, text] of content.trimEnd().split("\n").entries()) {
        checkedRecords++;
        const fields = Object.fromEntries(
          text
            .split(" detail=")[0]!
            .split(" ")
            .map((part) => part.split("=")),
        );
        if (
          fields.severity === policy.severity &&
          policy.components.includes(fields.component) &&
          fields.ack === String(policy.acknowledged) &&
          Number(fields.ts) >= policy.minimumTimestamp
        ) {
          incidents.push({ id: Number(fields.id), path, line: index + 1, text });
        }
      }
    }
    expect({ checkedRecords, incidents }).toEqual(incidentsTask.expected);
  });
  it("keeps fixtures under native read bounds and full-result controls genuinely complete", () => {
    for (const fixture of outputTasks)
      for (const content of Object.values(fixture.files)) {
        expect(Buffer.byteLength(content)).toBeLessThan(50000);
        expect(content.split("\n").length).toBeLessThan(2000);
      }
    const exported = task("OH9");
    expect(rows(exported, "export/").map((entry) => entry.data)).toEqual(exported.expected);
    const document = task("OH10");
    expect(document.files["handbook.txt"]).toBe(document.expected);
    for (const fixture of [exported, document])
      expect(Buffer.byteLength(JSON.stringify(fixture.expected))).toBeGreaterThan(8000);
  });
});
