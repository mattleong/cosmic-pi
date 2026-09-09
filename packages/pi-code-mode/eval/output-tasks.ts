/** Fresh output-focused fixtures. Historical H1-H10 are not confirmation data here. */
import type * as Schema from "effect/Schema";
import type { EvalTask } from "./tasks.ts";

type Row = Readonly<Record<string, Schema.Json>>;
const json = (value: Schema.Json) => JSON.stringify(value, null, 2) + "\n";
const note =
  "Reference metadata retained for audit: owner operations; region primary; retention standard; no pending action. ";
const citation = (prefix: string, index: number, size: number) => ({
  path: `${prefix}/part-${Math.floor(index / size)}.jsonl`,
  line: (index % size) + 1,
});
const shards = (prefix: string, rows: readonly Row[], size: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => [
      `${prefix}/part-${index}.jsonl`,
      rows
        .slice(index * size, (index + 1) * size)
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    ]),
  );
const task = (
  id: string,
  eligible: boolean,
  prompt: string,
  files: EvalTask["files"],
  expected: Schema.Json,
): EvalTask => ({
  id,
  split: id.startsWith("OD") ? "development" : "held-out",
  eligible,
  files,
  expected,
  prompt: `${prompt}\nReturn only the requested JSON answer. Preserve all requested evidence and completeness counts. Do not modify files.`,
});
const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, "0")}`;

const identities = Array.from({ length: 160 }, (_, n) => ({
  id: id("person", n),
  suspended: n === 13 || n === 94,
  expired: n === 94 || n === 126,
  department: "staff",
  profile: note.repeat(2),
}));
const history = Array.from({ length: 80 }, (_, n) =>
  Array.from({ length: 3 }, (_, sequence) => ({
    job: id("job", n),
    sequence,
    timestamp: sequence === 0 ? 100 : n === 61 ? 300 : 200,
    state:
      sequence === 0
        ? "queued"
        : sequence === 1
          ? "succeeded"
          : n === 12 || n === 45 || n === 61
            ? "running"
            : n === 53
              ? "cancelled"
              : "succeeded",
    metadata: note,
  })),
).flat();
const assets = Array.from({ length: 96 }, (_, n) => ({
  id: id("asset", n),
  digest: `digest-${n}`,
  published: n !== 83,
  metadata: note.repeat(2),
}));
const signatures = assets
  .filter((_, n) => n !== 7)
  .map((asset) => ({
    asset: asset.id,
    digest: asset.id === "asset-054" ? "wrong-digest" : asset.digest,
    signer: "release-team",
    metadata: note,
  }));
const activeLine = (n: number) =>
  `component-${n}: backupRetention=${n === 47 ? 7 : 14} tlsRequired=${n === 135 ? "false" : "true"}; ${note}`;
const runbooks = Object.fromEntries(
  Array.from({ length: 5 }, (_, file) => [
    `runbooks/${file}.md`,
    [
      "## Active",
      ...Array.from({ length: 40 }, (_, line) => activeLine(file * 40 + line)),
      "## Archived",
      "old-component: backupRetention=1 tlsRequired=false; historical only",
    ].join("\n") + "\n",
  ]),
);
const beforeApi = Array.from({ length: 100 }, (_, n) => ({
  endpoint: `/items/${n}`,
  request: { filter: { type: "string", required: false } },
  response: { count: "number", token: "string" },
  description: note,
}));
const afterApi = beforeApi.map((entry, n) => ({
  ...entry,
  request: { filter: { type: "string", required: n === 52 } },
  response:
    n === 7 ? { count: "number" } : { count: n === 81 ? "string" : "number", token: "string" },
}));
const catalog = Array.from({ length: 30 }, (_, n) => ({
  id: id("item", n),
  enabled: false,
  quota: 0,
  label: "",
  description: note.repeat(2),
}));
const aliases = Array.from({ length: 100 }, (_, n) => ({
  id: id("alias", n),
  target: n === 88 ? id("alias", 87) : id("item", n % 30),
  overrides: { enabled: false, quota: n === 12 ? 7 : 0, label: n === 88 ? null : "" },
  description: note.repeat(2),
}));
const dimensions = {
  os: ["linux", "mac", "windows"],
  db: ["sqlite", "pg"],
  feature: ["read", "write", "search", "session"],
  mode: ["local", "remote"],
};
const matrix = dimensions.os.flatMap((os) =>
  dimensions.db.flatMap((db) =>
    dimensions.feature.flatMap((feature) =>
      dimensions.mode.map((mode) => ({ os, db, feature, mode })),
    ),
  ),
);
const coverage = matrix.flatMap((combination, n) =>
  n === 7 || n === 35
    ? []
    : Array.from({ length: 4 }, (_, attempt) => ({
        ...combination,
        attempt,
        status: "pass",
        detail: note,
      })),
);
coverage.push({
  os: "plan9",
  db: "pg",
  feature: "read",
  mode: "local",
  attempt: 0,
  status: "pass",
  detail: note,
});
coverage.push({
  os: "windows",
  db: "sqlite",
  feature: "write",
  mode: "remote",
  attempt: 0,
  status: "fail",
  detail: note,
});
const incidentLine = (n: number) => {
  const qualifying = [120, 349, 580].includes(n);
  const excluded = [30, 150, 260, 450].includes(n);
  return `id=${n} ts=${n === 30 ? 49 : 100} severity=${qualifying || excluded ? "error" : "info"} component=${n === 260 ? "web" : "store"} ack=${n === 150 || n === 450 ? "true" : "false"} detail=error-budget review; ${note}`;
};
const incidentFiles = Object.fromEntries(
  Array.from({ length: 6 }, (_, file) => [
    `incidents/${file}.log`,
    Array.from({ length: 100 }, (_, line) => incidentLine(file * 100 + line)).join("\n") + "\n",
  ]),
);
const exportRows = Array.from({ length: 48 }, (_, n) => ({
  id: n,
  label: n % 2 ? `Zoë, record ${n}` : `Record "${n}"`,
  enabled: n % 3 === 0,
  quota: n % 4,
  note: note,
}));
const fullDocument =
  Array.from(
    { length: 60 },
    (_, n) =>
      `${String(n + 1).padStart(2, "0")}. Exact text: "Zoë" uses 0 retries and false flags. ${note}`,
  ).join("\n") + "\n";
const smallDocument =
  "# Literal document\n\n" +
  Array.from({ length: 12 }, (_, n) => `${n}: "quoted", café, false, 0.\n`).join("");

export const outputTasks: readonly EvalTask[] = [
  task(
    "OD1",
    true,
    "Inspect disks/*.json. Return {checked, overLimit} where overLimit contains every disk whose used exceeds limit, sorted by id, with {id,used,limit,path}.",
    {
      "disks/a.json": json({ id: "a", used: 9, limit: 10, inventory: note.repeat(15) }),
      "disks/b.json": json({ id: "b", used: 12, limit: 10, inventory: note.repeat(15) }),
      "disks/c.json": json({ id: "c", used: 0, limit: 0, inventory: note.repeat(15) }),
    },
    { checked: 3, overLimit: [{ id: "b", used: 12, limit: 10, path: "disks/b.json" }] },
  ),
  task(
    "OD2",
    true,
    "Read checks/*.jsonl. Blank lines and lines starting # are comments. Return {checked, failedIds}, with all failed check IDs sorted numerically.",
    {
      "checks/a.jsonl":
        "# format version 1\n" +
        Array.from({ length: 40 }, (_, n) =>
          JSON.stringify({ id: n, pass: n !== 12, detail: note }),
        ).join("\n") +
        "\n\n",
      "checks/b.jsonl":
        "\n# continued checks\n" +
        Array.from({ length: 40 }, (_, n) =>
          JSON.stringify({ id: n + 40, pass: n !== 17, detail: note }),
        ).join("\n") +
        "\n",
    },
    { checked: 80, failedIds: [12, 57] },
  ),
  task(
    "OD3",
    true,
    "Audit every *.txt file under instructions. Active lines begin LIVE; ignore OLD lines. Active lines must say tls=true. Return {checkedActive, findings:[{path,line,text}]} in path/line order; text must be the exact offending line.",
    {
      "instructions/a.txt": `LIVE tls=true ${note}\nOLD tls=false historical\nLIVE tls=false repair-needed\n`,
      "instructions/b.txt": `LIVE tls=true ${note}\nLIVE tls=true ${note}\n`,
    },
    {
      checkedActive: 4,
      findings: [{ path: "instructions/a.txt", line: 3, text: "LIVE tls=false repair-needed" }],
    },
  ),
  task(
    "OD4",
    false,
    "Return the complete contents of literal.md as one JSON string, preserving every character and the final newline.",
    { "literal.md": smallDocument },
    smallDocument,
  ),
  task(
    "OH1",
    true,
    "Evaluate all identities using policy.txt, in first-matching-rule order. Return {checked,denied:[{id,source:{path,line},rule:{path,line,text}}]}, sorted by id. Include every denied identity and exact decisive policy-line evidence.",
    {
      "policy.txt": "deny when suspended=true\ndeny when expired=true\nallow otherwise\n",
      ...shards("identities", identities, 40),
    },
    {
      checked: 160,
      denied: [13, 94, 126].map((n) => ({
        id: id("person", n),
        source: citation("identities", n, 40),
        rule: {
          path: "policy.txt",
          line: n === 126 ? 2 : 1,
          text: n === 126 ? "deny when expired=true" : "deny when suspended=true",
        },
      })),
    },
  ),
  task(
    "OH2",
    true,
    "Reconcile history/*.jsonl by job. The latest event is greatest timestamp, breaking ties by greatest sequence. A job is stale only when that event is running with timestamp <220. Return {checkedJobs,stale:[{job,timestamp,sequence,source:{path,line}}]}, sorted by job. Cancelled and succeeded jobs are not stale.",
    shards("history", history, 60),
    {
      checkedJobs: 80,
      stale: [12, 45].map((n) => ({
        job: id("job", n),
        timestamp: 200,
        sequence: 2,
        source: citation("history", n * 3 + 2, 60),
      })),
    },
  ),
  task(
    "OH3",
    true,
    "Audit release index entries against signatures.jsonl. Only published assets need a signature with the identical digest. Return {checkedAssets,publishedAssets,checkedSignatures,violations:[{id,problem,index:{path,line},signature:{path,line}|null}]}, sorted by id. Use problem missing-signature or digest-mismatch. A missing signature must be null.",
    {
      ...shards("assets", assets, 24),
      "signatures.jsonl": signatures.map((row) => JSON.stringify(row)).join("\n") + "\n",
    },
    {
      checkedAssets: 96,
      publishedAssets: 95,
      checkedSignatures: 95,
      violations: [
        {
          id: "asset-007",
          problem: "missing-signature",
          index: citation("assets", 7, 24),
          signature: null,
        },
        {
          id: "asset-054",
          problem: "digest-mismatch",
          index: citation("assets", 54, 24),
          signature: { path: "signatures.jsonl", line: 54 },
        },
      ],
    },
  ),
  task(
    "OH4",
    true,
    "Audit runbooks/*.md against policy.txt. Only lines within ## Active sections count; ## Archived ends an active section. Return {checkedActive,findings:[{path,line,text}]}, sorted by path then line. Include every violating active line exactly, without archived matches.",
    {
      "policy.txt": "Active instructions require backupRetention=14 and tlsRequired=true.\n",
      ...runbooks,
    },
    {
      checkedActive: 200,
      findings: [47, 135].map((n) => ({
        path: `runbooks/${Math.floor(n / 40)}.md`,
        line: (n % 40) + 2,
        text: activeLine(n),
      })),
    },
  ),
  task(
    "OH5",
    true,
    "Compare before and after API records by endpoint. Breaking changes are removed response fields, changed response field types, and request fields changing required=false to true. Ignore descriptions. Return {checkedEndpoints,changes:[{endpoint,field,kind,before,after,beforeSource:{path,line},afterSource:{path,line}}]}, sorted numerically by endpoint suffix. Use kinds removed, type-changed, made-required; missing values must be null.",
    {
      ...shards("before", beforeApi, 25),
      ...shards("after", afterApi, 25),
    },
    {
      checkedEndpoints: 100,
      changes: [
        {
          endpoint: "/items/7",
          field: "response.token",
          kind: "removed",
          before: "string",
          after: null,
          beforeSource: citation("before", 7, 25),
          afterSource: citation("after", 7, 25),
        },
        {
          endpoint: "/items/52",
          field: "request.filter.required",
          kind: "made-required",
          before: false,
          after: true,
          beforeSource: citation("before", 52, 25),
          afterSource: citation("after", 52, 25),
        },
        {
          endpoint: "/items/81",
          field: "response.count",
          kind: "type-changed",
          before: "number",
          after: "string",
          beforeSource: citation("before", 81, 25),
          afterSource: citation("after", 81, 25),
        },
      ],
    },
  ),
  task(
    "OH6",
    true,
    "Resolve every alias target through any alias chain to a catalog item. Compare each alias's own overrides with that terminal item's fields; intermediate aliases' overrides do not affect resolution. Return {checkedAliases,conflicts:[{alias,canonical,field,expected,actual,source:{path,line}}]}, sorted by alias then field. Empty string, zero, false, and null are distinct values.",
    {
      "catalog.json": json(catalog),
      ...shards("aliases", aliases, 25),
    },
    {
      checkedAliases: 100,
      conflicts: [
        {
          alias: "alias-012",
          canonical: "item-012",
          field: "quota",
          expected: 0,
          actual: 7,
          source: citation("aliases", 12, 25),
        },
        {
          alias: "alias-088",
          canonical: "item-027",
          field: "label",
          expected: "",
          actual: null,
          source: citation("aliases", 88, 25),
        },
      ],
    },
  ),
  task(
    "OH7",
    true,
    "required.json defines the Cartesian product of required coverage dimensions. A combination is covered only by a pass record in observations. Ignore out-of-matrix combinations and failed records. Return {requiredCombinations,observedRecords,coveredCombinations,ignoredOutOfMatrix,missing:[{os,db,feature,mode}]}, with missing sorted by os/db/feature/mode.",
    {
      "required.json": json(dimensions),
      ...shards("observations", coverage, 62),
    },
    {
      requiredCombinations: 48,
      observedRecords: 186,
      coveredCombinations: 46,
      ignoredOutOfMatrix: 1,
      missing: [
        { os: "linux", db: "sqlite", feature: "session", mode: "remote" },
        { os: "windows", db: "sqlite", feature: "write", mode: "remote" },
      ],
    },
  ),
  task(
    "OH8",
    true,
    "Find all incident records satisfying policy.json using structured fields before detail=. Words in detail are not fields. Return {checkedRecords,incidents:[{id,path,line,text}]}, sorted numerically by id. Include the complete exact qualifying lines and no excluded records.",
    {
      "policy.json": json({
        severity: "error",
        components: ["store", "router"],
        acknowledged: false,
        minimumTimestamp: 50,
      }),
      ...incidentFiles,
    },
    {
      checkedRecords: 600,
      incidents: [120, 349, 580].map((n) => ({
        id: n,
        path: `incidents/${Math.floor(n / 100)}.log`,
        line: (n % 100) + 1,
        text: incidentLine(n),
      })),
    },
  ),
  task(
    "OH9",
    false,
    "Export every record from export/*.jsonl as one JSON array sorted by numeric id. Preserve every field and value in every record. Do not substitute counts, summaries, samples, or file pointers.",
    shards("export", exportRows, 16),
    exportRows,
  ),
  task(
    "OH10",
    false,
    "Return the complete contents of handbook.txt as one JSON string, preserving every character, line, and final newline. Do not substitute a summary or pointer.",
    { "handbook.txt": fullDocument },
    fullDocument,
  ),
];
