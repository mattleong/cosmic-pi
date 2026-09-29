# Pi 0.99 API compatibility audit

## Scope and evidence

Reviewed all 12 workspace packages against the installed Pi 0.99.0 documentation,
public declarations, examples, and runtime. The comparison baseline is 0.86.0;
0.87.0 introduced important context and lifecycle changes before 0.99.0.

This is an audit, not an implementation plan approval. No extension implementation
was changed during the audit. Findings below distinguish reproduced failures,
contract-preservation decisions, and optional adoption.

Authoritative upstream reference for this audit:
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.
References prefixed `PI/` are relative to that installation. Package source locations
refer to the workspace at audit time.

## Already migrated

- Pi catalog pins and lockfile use 0.99.0.
- Host-provided packages use `*` peer ranges; TypeBox is no longer a production dependency.
- Tool execution context annotations and ToolInfo exposure fixtures were updated.
- Better OpenAI uses `context_with_system` and canonical session projection for
  compaction repair, including persisted context edits and encrypted-prefix invalidation.
- Built-in MCP is disabled in the current user's settings while workspace MCP remains enabled.

A passing typecheck and the previous full validation gate did not detect the runtime
issues below.

## Required compatibility fixes

### 1. P1: Code Mode treats failed Bash commands as success

**Location:** `packages/pi-code-mode/src/boundary/host-builtin-tools.ts:197–210`.

Pi 0.99's Bash definition returns `isError: true` and structured exit data on a
nonzero exit rather than rejecting its Promise. Our resolved-result branch always
records `isError: false` and resolves the guest call with text.

Reproduction through the running Code Mode tool:

```js
try {
  const result = await tools.pi.bash({
    command: "printf 'pi-099-audit-probe\\n'; exit 7",
  });
  return { resolved: true, result };
} catch (error) {
  return { resolved: false, message: error.message };
}
```

This returned `resolved: true`, with text ending in `Command exited with code 7`.
Dependent operations can continue; try/catch, allSettled, receipts, and presentation
misclassify failure. This violates the explicit catchable-failure contract in
`packages/pi-code-mode/src/tools/catalog.ts:87–91`.

**Update:** Recognize returned native error results, preserve bounded error evidence,
record completed/error, and produce the existing catchable ToolError. Do not turn a
normally delivered native error into delivery-loss evidence.

**Regression tests:** Nonzero real Bash exit; returned-error adapter fixture;
unhandled error prevents subsequent statements; caught error preserves error receipts.

**Upstream:** `PI/dist/core/tools/bash.js:287–305`.

### 2. P2: Subagents discard RPC input dispositions

**Location:** `packages/pi-subagents/src/backend/local-pi.ts:511–528`.

Successful RPC responses now distinguish queued input from input consumed by an
extension. The backend discards `data.disposition` for prompt and steering.
A consumed assignment produces no agent run or settled event, so the supervisor can
leave an active slot occupied indefinitely. Consumed guidance is reported as delivered.

An offline RPC probe using the existing input-extension fixture returned
`disposition: "handled"` with no lifecycle events; the backend accepted equivalent
responses as ordinary success.

**Update:** Decode command-specific dispositions and settle consumed assignments
explicitly. Distinguish consumed guidance from queued guidance. Do not automatically
replay inputs: consumption is not evidence that no side effect occurred.

**Regression tests:** Handled initial prompt, queued steering, handled steering,
and normal run settlement.

**Upstream:** `PI/docs/rpc.md:67`, `PI/docs/rpc-commands.md:40,66`,
`PI/dist/modes/rpc/rpc-mode.js:298–325`.

### 3. P2: Nested parent questions block cooperative claim grants

**Locations:**

- `packages/pi-subagents/src/boundary/host-child.ts:338–347`
- `packages/pi-subagents/src/boundary/host-pi-supervisor-extension.ts:260–275`
- `packages/pi-subagents/src/run/write-claim-control.ts:45–51`

Parent-question tools default to direct exposure and are now callable from native
codemode. A writer awaiting a nested parent question has both the parent codemode call
and the question active. Claim admission correctly refuses to grant another file
while the outer call remains active. The actual claim-control service reproduced
`write_claim_change_not_waiting` for that state.

**Update:** Mark blocking parent-contact and supervisor-question tools `model-only`.
Do not weaken claim admission by ignoring outer tools: a script may have active siblings.

**Regression tests:** These tools are absent from the callable loadout, while direct
questions still permit grants after the existing checks.

**Upstream:** `PI/docs/extensions.md:148–161`; nested execution events include
`parentToolCallId`.

### 4. P2: Herdr rejects standalone virtual models as missing credentials

**Location:** `packages/pi-subagents/src/boundary/host-profile-resolution.ts:117–134`.

Pi marks a standalone virtual provider available without a provider key. Its synthetic
auth status uses `source: "environment", label: "virtual"`. Our Herdr readiness logic
treats that as an API key that must be transferred and rejects the route.
An installed-runtime probe confirmed the router was available and credential checks
succeeded despite having no transferable virtual-provider key.

**Update:** Separate virtual selection availability from physical-provider credential
transfer. Verify router registration and physical-target readiness in the child.
Account for targets that rely on parent-only runtime/environment credentials rather
than assuming all virtual selections can launch remotely.

**Regression tests:** Standalone router with stored physical credentials; missing child
router; physical target requiring a parent-only runtime key.

**Upstream:** `PI/docs/virtual-models.md:55,65`,
`PI/dist/core/virtual-models.js:88–96`, `PI/dist/core/model-runtime.js:436–445`.

### 5. P2: Context edits bypass forked-history thinking sanitization

**Location:** `packages/pi-subagents/src/boundary/child-process.ts:192–203`.

Fork cloning strips thinking from raw assistant messages but copies context-edit
replacements unchanged. Canonical projection can then restore signed/redacted thinking
from an assistant-content replacement. A probe of actual createForkedSession showed
text-only raw assistant content but signed thinking in projected child context.

**Update:** Apply equivalent portability sanitization to assistant-targeted replacement
content. Preserve IDs, targets, omission semantics, compaction anchors, and edits to
other roles.

**Regression tests:** Assistant replacement containing thinking; omission; text-only
replacement; edits targeting other roles; projected child context.

**Upstream:** `PI/docs/session-format.md` ContextEditEntry and Context Building;
`PI/dist/core/session-manager.js:239–253`.

### 6. P2: OpenAI subscription usage reads the wrong authentication provider

**Locations:**

- `packages/pi-better-openai/src/usage/projection.ts:44–48`
- `packages/pi-better-openai/src/usage/controller.ts:78–98`
- `packages/pi-better-openai/src/auth/codex-auth.ts:55`

Usage eligibility accepts new `openai` OAuth, but credential lookup always requests
`openai-codex`. A user signed in only through `/login openai` is told to sign in to the
legacy provider. If both providers belong to different accounts, the displayed usage
can come from the legacy account rather than the selected account.
A fake-registry probe confirmed only openai-codex was queried.

**Update:** Separate legacy usage authentication from the new ChatGPT/OpenAI flow.
Show an explicit unsupported state when necessary. Verify the new provider's usage API
before adding support; its public-API token must not simply be sent to legacy endpoints.

**Regression tests:** OpenAI-only OAuth, legacy-only OAuth, API key, and differing accounts.

**Upstream:** Installed pi-ai `dist/providers/openai.js:8–21`,
`dist/providers/openai-codex.js:8–10`, and `dist/auth/oauth/openai-chatgpt.js`.

### 7. P2: Fast mode confuses selected virtual model with physical dispatch

**Location:** `packages/pi-better-openai/src/fast/controller.ts:17–20,42–51`,
called by `src/application.ts:473–480`.

A legal `openai/auto` virtual selection can dispatch Anthropic. Fast mode still adds
`service_tier: "priority"` to that request. A `router/auto` selection dispatching OpenAI
has the opposite problem: no fast injection. Both cases were reproduced against the
injection function.

**Update:** Fail closed for virtual selections until authoritative request identity is
available. Do not infer the physical provider from the virtual provider label or assume
that the provider hook context has been changed to the dispatched model.

**Regression tests:** Virtual OpenAI→Anthropic, custom router→OpenAI, and ordinary OpenAI.
Audit corresponding child fast-mode paths when defining the shared policy.

**Upstream:** `PI/docs/virtual-models.md:23–25,55,65`;
`PI/dist/core/extensions/types.d.ts:660–673`. Current request hooks expose payload/headers,
not an authoritative physical-model field.

### 8. P2: Image generation can send a virtual model ID to Codex

**Location:** `packages/pi-better-openai/src/image/service.ts:35–46,92,130`.

With virtual `openai-codex/auto` selected, image generation without an override inherits
`auto` and sends it directly to the hosted Codex endpoint rather than routing it.

**Update:** Use a configured physical image-request fallback for virtual selections;
reject virtual explicit overrides unless deliberate routing support is implemented.

**Regression tests:** Virtual current selection, virtual explicit override, and physical
model fallback/override.

**Upstream:** `PI/docs/virtual-models.md` Selection and dispatch / Route requests.

### 9. P3: Settings headings retain old colors after system-theme changes

**Locations:** `packages/pi-cosmic-ui/src/settings/controller.ts:175` and
`packages/pi-better-xai/src/settings/controller.ts:55`.

The headings store already-colored strings in Text. Automatic system-theme changes
invalidate layout but do not recolor those strings. A real Text probe retained old output
after dark→light and invalidate, unlike a newly themed heading.

**Update:** Render headings using live theme callbacks or rebuild styled text during
invalidation. No blanket migration away from theme.fg/bg is needed.

**Regression test:** Theme transition while the same settings component remains mounted;
test state/recomputation rather than exact ANSI bytes or colors.

**Upstream:** `PI/docs/themes.md:7–22`, `PI/docs/tui.md:100`.

## Explicit compatibility decisions

### Make Code Mode model-only unless nested evidence loss is supported intentionally

`packages/pi-code-mode/src/tools/controller.ts:210–265` defaults to direct exposure.
Native codemode can call it and discard its returned text. Pi persists bounded nested
call metadata, not nested results, so recovery IDs, no-replay warnings, and detailed
receipts need not reach the transcript. Native codemode's only mode hides the direct
Code Mode declaration and encourages this route.

Recommended: `exposure: "model-only"`, preserving the existing outermost-evidence
contract. This is not a claim that native nested calls bypass Pi permissions: they run
through tool hooks. Ask User's blocking and asynchronous tools should also get an
intentional exposure policy; no bypass of their existing queue/ownership checks was found.

### Keep custom Code Mode dispatch deliberate

Native `ctx.executeTool()` is not a mechanical replacement for our direct fresh-definition
calls. It invokes registered overrides and middleware and supplies native nested events,
compaction records, and usage aggregation. Migrating changes the current documented
authority and output contracts. If adopted, preserve the reviewed catalog and producer
restrictions rather than exposing every registered tool accidentally.

### Document custom MCP interoperability

Workspace MCP does not consume `pi.getMcpServers()` or `mcp_servers_change`, and it uses
different configuration and credential stores. Other extensions' registerMcpServer calls
therefore report unhandled registrations rather than connecting through our gateway.
Native `pi mcp` shell commands continue to manage the built-in implementation even when
our extension owns `/mcp`.

Supporting native registrations/configuration needs explicit policy mapping; silently
merging them could change trust, authentication, and execution behavior.

## Optional simplifications and new capabilities

- Return native `isError` directly for evidence-bearing failures in MCP, Subagents, and
  Code Mode where appropriate. Existing bounded error receipt hooks still work, but can
  be simplified now. Preserve recovery details and cancellation behavior.
- Add outputSchema/structuredContent for deliberately programmatic tools. Publish only
  already-bounded, cancellation-checked replies, not raw MCP or process output.
- Add namespace and truthful annotations where useful. Mixed-action gateways must not
  advertise blanket read-only or idempotent hints.
- Consider prepareLoadout for tool declaration management if adopting native orchestration.
- Cosmic UI could show selected→physical routed models, rather than selection alone.
  Provider usage indicators likewise need an intentional routed-model policy.
- ModelRuntime image/classifier APIs are opportunities, not mandatory migrations.
  Native image generation currently supports OpenRouter images, not our hosted Codex
  image_generation route; it is not a drop-in substitute. Extension ModelRegistry's
  compatibility facade also differs from full ModelRuntime.
- provider_stream_event is available for opt-in diagnostics; no existing responsibility
  requires registering it, and handlers can delay streaming or expose sensitive events.
- Update the obsolete first-assistant persistence comment in
  `packages/pi-herdr-btw/src/boundary/session-file.ts:185–186`: Pi now persists on the first
  user message. Pre-message blank-session initialization remains useful.

## Package coverage

| Package             | Outcome                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| pi-ask-user         | Lifecycle, context filtering, queueing, cancellation remain compatible. Decide exposure intentionally.                       |
| pi-background-task  | No mandatory migration found. Structured output optional; inspecting a failed process is not itself a failed status call.    |
| pi-better-openai    | Usage auth, virtual fast mode, virtual image fallback need fixes. Canonical context migration already present.               |
| pi-better-xai       | Theme-reactive heading fix; routed-provider indicators optional.                                                             |
| pi-code-mode        | Bash failure regression; model-only exposure recommended; native dispatch requires a design decision.                        |
| pi-code-previews    | Wrappers preserve outputSchema, structuredContent, isError, and definition metadata. Builtin source checks remain correct.   |
| pi-cosmic-core      | No concrete required migration found; supported compatibility helpers remain valid.                                          |
| pi-cosmic-ui        | Theme-reactive heading fix; physical route display optional. Existing owned-overlay workaround remains justified by runtime. |
| pi-directory-models | No required migration found. Persisting selected virtual identity rather than physical dispatch is correct.                  |
| pi-herdr-btw        | No functional migration found; session-persistence comment is stale.                                                         |
| pi-mcp              | Existing error propagation remains functional. Native registration/config support is an explicit interoperability decision.  |
| pi-subagents        | RPC dispositions, nested parent questions, virtual auth readiness, and context-edit fork sanitization need fixes.            |

## Verification and order

Used targeted offline/runtime probes, including the Bash probe in this session.
The reviewers ran directory-models (28 tests), herdr-btw (101), and five relevant
subagents suites (31); all passed. Full workspace validation was not rerun for this
read-only audit. Existing tests passing does not cover the reproduced new cases.

Recommended implementation order:

1. Fix Code Mode's Bash failure semantics.
2. Set evidence-sensitive/blocking tool exposures and test native nested loadouts.
3. Fix RPC dispositions and fork context-edit sanitization.
4. Make virtual-model request/auth/image handling safe, then improve routed UI.
5. Correct OpenAI usage-auth eligibility; add new subscription support only after verifying its API.
6. Fix theme-reactive headings.
7. Consider optional native API adoption in separate, explicitly scoped changes.
