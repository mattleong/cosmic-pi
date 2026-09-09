/** Frozen, read-only fixtures. Answers are checked outside the agent's tool namespace. */
import type * as Schema from "effect/Schema";
export interface EvalTask {
  readonly id: string;
  readonly split: "development" | "held-out";
  readonly eligible: boolean;
  readonly prompt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: Schema.Json;
}

const json = (value: Schema.Json): string => JSON.stringify(value, null, 2) + "\n";
const task = (
  id: string,
  split: EvalTask["split"],
  eligible: boolean,
  prompt: string,
  files: EvalTask["files"],
  expected: Schema.Json,
): EvalTask => ({
  id,
  split,
  eligible,
  prompt: `${prompt}\nReturn only the requested answer as JSON, without a Markdown fence. Do not modify files.`,
  files,
  expected,
});

export const tasks: readonly EvalTask[] = [
  task(
    "D1",
    "development",
    true,
    "Report the version of each package under packages as an object keyed by package name.",
    {
      "packages/alpha/package.json": json({ name: "alpha", version: "1.2.0" }),
      "packages/beta/package.json": json({ name: "beta", version: "1.3.0" }),
      "packages/gamma/package.json": json({ name: "gamma", version: "1.2.0" }),
      "packages/delta/package.json": json({ name: "delta", version: "2.0.0" }),
    },
    { alpha: "1.2.0", beta: "1.3.0", gamma: "1.2.0", delta: "2.0.0" },
  ),
  task(
    "D2",
    "development",
    true,
    "Count literal TODO and FIXME occurrences across notes/*.md. Return an object with TODO and FIXME totals.",
    {
      "notes/a.md": "# Work\nTODO: parser\nTODO: reader\nFIXME: timeout\n",
      "notes/b.md": "# Review\nFIXME: retry\nTODO: cleanup\n",
      "notes/c.md": "# Closed\nNo outstanding items.\n",
    },
    { TODO: 3, FIXME: 2 },
  ),
  task(
    "D3",
    "development",
    true,
    "Resolve defaults.json with each service's overrides. Return an object keyed by service name with the complete resolved values.",
    {
      "defaults.json": json({ retries: 3, timeout: 30, trace: true }),
      "services/api.json": json({ timeout: 10, trace: false }),
      "services/worker.json": json({ retries: 0 }),
    },
    {
      api: { retries: 3, timeout: 10, trace: false },
      worker: { retries: 0, timeout: 30, trace: true },
    },
  ),
  task(
    "D4",
    "development",
    false,
    "What version is recorded in VERSION? Return a JSON string.",
    { VERSION: "1.8.2\n" },
    "1.8.2",
  ),
  task(
    "H1",
    "held-out",
    true,
    "Calculate net paid order totals by customer region, subtracting refunds only for paid orders. Return an object mapping region to integer cents.",
    {
      "customers.json": json([
        { id: "c1", region: "EU" },
        { id: "c2", region: "US" },
        { id: "c3", region: "EU" },
      ]),
      "orders.json": json([
        { id: "o1", customer: "c1", status: "paid", cents: 1000 },
        { id: "o2", customer: "c2", status: "paid", cents: 2000 },
        { id: "o3", customer: "c1", status: "void", cents: 700 },
        { id: "o4", customer: "c3", status: "paid", cents: 500 },
        { id: "o5", customer: "c2", status: "paid", cents: 300 },
      ]),
      "refunds.json": json([
        { order: "o1", cents: 200 },
        { order: "o4", cents: 100 },
        { order: "o5", cents: 300 },
      ]),
    },
    { EU: 1200, US: 2000 },
  ),
  task(
    "H2",
    "held-out",
    true,
    "Find all transitive dependencies of app using the manifests in packages. Exclude app itself and return a sorted array of names.",
    Object.fromEntries(
      (
        [
          ["app", ["ui", "api"]],
          ["ui", ["core"]],
          ["api", ["core", "db"]],
          ["db", ["core"]],
          ["core", []],
          ["unused", []],
        ] satisfies Array<[string, string[]]>
      ).map(([name, dependencies]) => [
        `packages/${name}/manifest.json`,
        json({ name, dependencies }),
      ]),
    ),
    ["api", "core", "db", "ui"],
  ),
  task(
    "H3",
    "held-out",
    true,
    "Resolve configuration with precedence defaults, then production, then service. Return api and job objects with complete resolved configuration.",
    {
      "defaults.json": json({ retry: 3, timeout: 30, trace: false }),
      "production.json": json({ retry: 0, trace: true }),
      "services/api.json": json({ timeout: 10, trace: false }),
      "services/job.json": json({ retry: 2 }),
    },
    { api: { retry: 0, timeout: 10, trace: false }, job: { retry: 2, timeout: 30, trace: true } },
  ),
  task(
    "H4",
    "held-out",
    true,
    "Across logs/*.jsonl, report error count and maximum latency among errors per service. Return {service: {errors, maxLatency}}.",
    Object.fromEntries(
      Array.from({ length: 5 }, (_, shard) => [
        `logs/${shard}.jsonl`,
        Array.from({ length: 400 }, (_, offset) => {
          const id = shard * 400 + offset;
          return JSON.stringify({
            id,
            service: id % 3 === 0 ? "api" : "worker",
            level: id % 17 === 0 ? "error" : "info",
            latency: (id % 97) + 1,
          });
        }).join("\n") + "\n",
      ]),
    ),
    { api: { errors: 40, maxLatency: 97 }, worker: { errors: 78, maxLatency: 96 } },
  ),
  task(
    "H5",
    "held-out",
    true,
    "Compare the scripts in packages/*/package.json. Return only scripts whose value differs between packages, keyed by script then package name. Omit scripts identical everywhere.",
    {
      "packages/red/package.json": json({
        scripts: { test: "vitest run", lint: "oxlint .", check: "tsc --noEmit" },
      }),
      "packages/blue/package.json": json({
        scripts: { test: "node --test", lint: "oxlint .", check: "tsc --noEmit" },
      }),
      "packages/green/package.json": json({
        scripts: { test: "vitest run", lint: "oxlint .", check: "tsc --noEmit" },
      }),
      "packages/white/package.json": json({
        scripts: { test: "vitest run", lint: "oxlint .", check: "tsc --noEmit" },
      }),
    },
    { test: { red: "vitest run", blue: "node --test", green: "vitest run", white: "vitest run" } },
  ),
  task(
    "H6",
    "held-out",
    true,
    "Join users with active subscriptions. Deduplicate user IDs, sort numerically, and return an array of {id,name} objects for active users only.",
    {
      "users.json": json([
        { id: 1, name: "Ada" },
        { id: 2, name: 'Zoë, "Z"' },
        { id: 3, name: "Bo" },
      ]),
      "subscriptions.json": json([
        { user: 2, status: "active" },
        { user: 2, status: "active" },
        { user: 3, status: "active" },
        { user: 1, status: "inactive" },
      ]),
    },
    [
      { id: 2, name: 'Zoë, "Z"' },
      { id: 3, name: "Bo" },
    ],
  ),
  task(
    "H7",
    "held-out",
    true,
    "Using migration-map.json, identify the routes whose destination would change. Return a sorted array of {source,destination,permanent} with the proposed destination. Do not change files.",
    {
      "migration-map.json": json({ "/v1": "/v3" }),
      "routes/a.json": json([
        { source: "/a", destination: "/v1", permanent: true },
        { source: "/health", destination: "/health", permanent: false },
      ]),
      "routes/b.json": json([
        { source: "/b", destination: "/v1", permanent: false },
        { source: "/c", destination: "/v2", permanent: true },
      ]),
    },
    [
      { source: "/a", destination: "/v3", permanent: true },
      { source: "/b", destination: "/v3", permanent: false },
    ],
  ),
  task(
    "H8",
    "held-out",
    true,
    "Find the current release for each service listed in index.json. Its paths may be stale; locate current release files if needed. Return an object keyed by service containing its revision string.",
    {
      "index.json": json({ api: "releases/api.json", worker: "releases/worker.json" }),
      "current/api.json": json({ service: "api", revision: "a17" }),
      "current/worker.json": json({ service: "worker", revision: "b09" }),
    },
    { api: "a17", worker: "b09" },
  ),
  task(
    "H9",
    "held-out",
    false,
    "What version is recorded in VERSION? Return a JSON string.",
    { VERSION: "2.7.4\n" },
    "2.7.4",
  ),
  task("H10", "held-out", false, "Calculate 37 multiplied by 19. Return a JSON number.", {}, 703),
];
