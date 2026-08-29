# ADR 0005: Root-coordinated nested subagents and native runtime agents

- Status: Accepted
- Date: 2026-08-24
- Supersedes: the recursion guard and one-parent fleet ownership clauses of [ADR 0002](0002-multi-backend-subagents.md)

## Context

ADR 0002 prevented recursion by withholding subagent orchestration from child Pi processes. That kept writer ownership simple, but it also forced every delegation decision through the root Pi turn. Claude and Codex native agent support was disabled for the same reason, even though native agents do not need independent Pi lifecycle ownership.

A nested design is safe only if it keeps one authority for configuration, process ownership, writer leases, ancestry, and cleanup. Starting another `SubagentService` inside a child would split those authorities and make ancestry and writer claims forgeable.

## Decision

### One root coordinator

The root Pi session is depth 0. It owns the only profile/config service, backend registry, run registry, writer pools and leases, completion outbox, and descendant processes. A virtual `root` node anchors the run tree.

Nested Pi processes load packaged private integrations. Those integrations expose proxy tools and a subtree manager, but they do not construct application services or read subagent configuration. Local Pi uses its inherited per-process Node IPC connection directly to the root. Herdr Pi uses its per-run authenticated supervisor channel. Both transports bind the caller run ID at the server. Proxy payloads cannot supply ancestry.

Each run records immutable `parentRunId` and `depth`. The root can inspect the complete tree. A nested caller can inspect itself and descendants, and server authorization rejects ancestor and sibling targets as not found.

### Nesting policy

Configuration version 5 introduced the nesting policy:

```json
{
  "version": 5,
  "nesting": {
    "maxDirectChildren": 12,
    "maxDepth": 3
  }
}
```

Direct-child bounds are 1 through 32. Depth bounds are 0 through 8. Configuration version 6 retains this document-level policy while moving routes into named profile sets. Versions 4 and 5 remain readable; a successful current store write migrates either legacy version to version 6. Present invalid values fail strict decoding; values are never clamped.

Precedence is Session, trusted Project, Global, then Built-in. A start batch captures one profile and policy revision. Admission counts active direct children and in-flight reservations for the selected parent. There is no tree-wide active-run budget. Lowering a policy changes later admission only.

A node at `maxDepth` cannot spawn. Nested Pi may select every configured profile, including `worker`. The root applies the existing same-cwd writer pool, lease, and disjoint-claim checks across the whole tree.

### Lifecycle and delivery

Natural completion or failure of an intermediate Pi node does not stop descendants. Explicit stop marks the subtree against new admission, then closes descendants leaf-first before the selected node. Root replacement and shutdown close the complete tree leaf-first.

A retry successor keeps the failed predecessor's parent. Existing descendants remain attached to the predecessor.

Questions and unclaimed outcomes go to the nearest connected Pi ancestor. If no Pi ancestor accepts the delivery, the root host receives it. Delivery acknowledgement still owns completion removal.

### Herdr Pi resources

Herdr Pi mirrors the root session's project-trust decision with `--approve` or `--no-approve` while always keeping `--no-skills`, `--no-prompt-templates`, and `--no-context-files`. It does not use `--no-extensions` or `--no-themes`, so trusted launches can discover project and global extensions while untrusted launches remain global-only. The packaged lifecycle and supervisor integrations remain explicit. At each launch the root supplies its current active tool-name snapshot, independent of Pi write intent; competing orchestrators remain excluded and package-owned `subagent_*` tools use authenticated proxies.

### Code Mode and cooperative writer claims

An active, discoverable Code Mode tool gives a Pi child the same seven direct nested built-ins that the tool gives the root Pi session. Inheriting it does not create a separate capability policy. The model must apply the assignment's `writeIntent` and exact-file claims when it writes the Code Mode program.

The Code Mode interpreter does not authorize paths against writer claims. Its nested built-in calls also bypass Pi tool middleware, approvals, registered overrides, and `pi-subagents` claim observation. Claims therefore remain admission and coordination rules, not filesystem confinement. A compliant agent should write programs that stay within its claims, but the coordinator may not observe or interrupt an out-of-claim nested mutation.

### Native runtime agents

Claude and Codex may use their native agent systems within configured runtime limits. Native agents inherit the parent's runtime sandbox and writer lease. They never become Pi run nodes, cannot acquire independent Pi writer claims, and do not affect Pi depth or direct-child admission.

Claude allows `Agent`, `Task`, `TaskOutput`, `TaskStop`, and `SendMessage`, and requests forwarded native-agent text. Codex enables its native agent configuration and strictly decodes known collaboration and sub-agent activity items. Unknown native shapes fail the adapter protocol.

The parent run projection keeps bounded native activity: active count, total observed count, and the latest event. Native controls remain inside the runtime and are not exposed through Pi tools or the fleet UI.

## Consequences

- The root process may own a wide tree, so active process count is controlled only by per-parent limits and host/runtime limits.
- Terminal history may exceed the old flat-fleet count when preserving ancestry or unresolved delivery requires it. History retention cannot become a hidden tree-wide admission budget.
- A disconnected intermediate node cannot make new requests, but its existing descendants continue under root ownership.
- Local and Herdr Pi use different authenticated transports behind one authorization policy.
- Global Pi extensions are trusted code in delegated Herdr Pi. Project-local resources remain blocked by Pi project trust rather than by disabling global discovery.
- Native protocol evolution requires explicit schema updates before new shapes are accepted.
