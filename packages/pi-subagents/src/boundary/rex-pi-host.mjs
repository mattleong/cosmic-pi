// @ts-check

/** Native Node entrypoint for the child Pi inside a Rex terminal. Pi owns the TUI and session. */
import { readFileSync, statSync } from "node:fs";
import * as nodeHttp from "node:http";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import { REX_PROMPT_EVENT } from "./rex-prompt.mjs";

/** @typedef {typeof import('@earendil-works/pi-coding-agent')} Sdk */
/** @typedef {import('@earendil-works/pi-coding-agent').AgentSession} AgentSession */
/** @typedef {import('./rex-prompt.mjs').RexPrompt} RexPrompt */

const packageName = "@earendil-works/pi-coding-agent";
const decodePiPackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.Literal(packageName),
      version: Schema.String,
      exports: Schema.Struct({ ".": Schema.Struct({ import: Schema.String }) }),
    }),
  ),
);

/** Load the public ESM export of the same installed Pi the launcher would have run. Never search cwd. */
export function loadRexPiSdk() {
  const directory = process.env.PI_PACKAGE_DIR;
  if (!directory) return import("@earendil-works/pi-coding-agent");
  const manifest = decodePiPackage(readFileSync(join(directory, "package.json"), "utf8"));
  return import(pathToFileURL(join(directory, manifest.exports["."].import)).href).then(
    /** @param {Sdk} sdk */ (sdk) => {
      if (sdk.VERSION !== manifest.version) throw new Error("Installed Pi SDK version mismatch.");
      return sdk;
    },
  );
}

/** @typedef {{ setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => void }} ProxySupport */
/** Node provides this public operation on newer releases than the minimum supported Node 22. */
/** @type {typeof nodeHttp & ProxySupport} */
const network = nodeHttp;

/** @param {string | undefined} setting @param {NodeJS.ProcessEnv} env @param {ProxySupport} [support] */
export function configureRexPiProxy(setting, env, support = network) {
  const proxy = setting?.trim();
  if (proxy) {
    env.HTTP_PROXY ??= proxy;
    env.HTTPS_PROXY ??= proxy;
  }
  if (!(env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY)) return;
  if (!support.setGlobalProxyFromEnv)
    throw new Error(
      "A proxy is configured but this Node version cannot configure the Rex Pi HTTP transport. Use headless subagents or a Node version with http.setGlobalProxyFromEnv.",
    );
  support.setGlobalProxyFromEnv(env);
}

const isPromptQuery = Schema.is(Schema.Struct({ sessionId: Schema.String }));

/**
 * Only the prompt operation crosses the per-session event bus, never the AgentSession. A retained
 * operation cannot cross /reload or a session switch, even to a new instance with the same id.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {() => AgentSession | undefined} getSession
 */
export function provideRexPrompt(pi, getSession) {
  let retired = false;
  pi.on("session_shutdown", () => {
    retired = true;
  });
  pi.events.on(REX_PROMPT_EVENT, (query) => {
    const session = getSession();
    if (retired || !session || !isPromptQuery(query) || query.sessionId !== session.sessionId)
      return;
    /** @type {RexPrompt} */
    const prompt = (text, steer) =>
      new Promise((resolve, reject) => {
        if (retired || getSession() !== session) throw new Error("Rex prompt session has changed.");
        // Same boundary as Pi's RPC prompt response. prompt() completion is neither an admission
        // nor a rejection after preflight: agent_settled handlers can even defer work past it.
        session
          .prompt(text, {
            // Parent text is an extension's user message, not a command typed into the pane.
            source: "extension",
            expandPromptTemplates: false,
            ...(steer && { streamingBehavior: "steer" }),
            preflightResult: resolve,
          })
          .catch(reject);
      });
    Object.assign(query, { prompt });
  });
}

const valueFlags = new Set([
  "--model",
  "--thinking",
  "--tools",
  "--exclude-tools",
  "--append-system-prompt",
  "--name",
  "--extension",
  "--session",
  "--session-dir",
]);
const switches = new Set(["--pi-subagents-fast-mode", "--approve", "--no-approve"]);

/** @param {Sdk} sdk @param {string[]} args */
function childOptions(sdk, args) {
  // A new CLI option must not appear to work but be dropped by this SDK host. Pi still parses
  // values (notably tool lists, thinking and registered extension flags) just as in RPC mode.
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (seen.has(flag) || (!valueFlags.has(flag) && !switches.has(flag)))
      throw new Error(`Unexpected Rex child argument: ${flag}`);
    seen.add(flag);
    if (valueFlags.has(flag)) i++;
  }
  const parsed = sdk.parseArgs(args);
  if (parsed.diagnostics.length)
    throw new Error(parsed.diagnostics.map((d) => d.message).join("\n"));
  const {
    model,
    thinking,
    tools,
    excludeTools,
    projectTrustOverride,
    name,
    appendSystemPrompt,
    extensions,
    session,
    sessionDir,
  } = parsed;
  const prompt = appendSystemPrompt?.[0];
  const extension = extensions?.[0];
  if (
    !model ||
    !thinking ||
    !tools?.length ||
    !excludeTools?.length ||
    !name?.trim() ||
    !extension ||
    !isAbsolute(extension) ||
    !prompt ||
    !isAbsolute(prompt) ||
    seen.has("--approve") === seen.has("--no-approve") ||
    projectTrustOverride === undefined ||
    Boolean(session) === Boolean(sessionDir) ||
    !isAbsolute(session ?? sessionDir ?? "")
  )
    throw new Error("Incomplete or ambiguous Rex child launch policy.");
  if (tools.some((t) => /^[+-]|\*/u.test(t)))
    throw new Error("Rex child active tools must be exact names.");
  return {
    model,
    thinking,
    tools,
    excludeTools,
    name: name.trim(),
    projectTrusted: projectTrustOverride,
    extension,
    prompt,
    session,
    sessionDir,
    flags: parsed.unknownFlags,
  };
}

/**
 * Mirrors the Pi 1.5 CLI's createRuntime factory using only public SDK operations. Services
 * (including provider and extension registrations) belong to the effective session cwd.
 * @param {Sdk} sdk
 * @param {string[]} args Exactly child-process.ts's sessionArgs, without a CLI executable or mode.
 * @param {string} [cwd]
 * @param {string} [agentDir]
 */
export async function createRexPiRuntime(
  sdk,
  args,
  cwd = process.cwd(),
  agentDir = sdk.getAgentDir(),
) {
  const policy = childOptions(sdk, args);
  // SessionManager.open also supports creating a session at a missing/empty path. Here --session
  // means only an existing fork or resume; losing its history must stop the launch.
  if (policy.session && !statSync(policy.session).size)
    throw new Error("Empty Rex child session file.");
  const sessionManager = policy.session
    ? sdk.SessionManager.open(policy.session)
    : sdk.SessionManager.create(cwd, policy.sessionDir);
  sessionManager.appendSessionInfo(policy.name);

  /** @type {{ runtime?: import('@earendil-works/pi-coding-agent').AgentSessionRuntime }} */
  const active = {};
  /** @type {import('@earendil-works/pi-coding-agent').CreateAgentSessionRuntimeFactory} */
  const factory = async (target) => {
    const settingsManager = sdk.SettingsManager.create(target.cwd, target.agentDir, {
      projectTrusted: policy.projectTrusted,
    });
    const services = await sdk.createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      extensionFlagValues: policy.flags,
      resourceLoaderOptions: {
        additionalExtensionPaths: [policy.extension],
        appendSystemPrompt: [policy.prompt],
        extensionFactories: [
          {
            name: "codemode",
            builtin: true,
            replaceable: true,
            factory: sdk.createCodemodeExtension(),
          },
          {
            name: "tool-search",
            builtin: true,
            replaceable: true,
            factory: sdk.createToolSearchExtension(),
          },
          { name: "mcp", builtin: true, replaceable: true, factory: sdk.createMcpExtension() },
          {
            name: "rex-prompt",
            hidden: true,
            factory: (pi) =>
              provideRexPrompt(pi, () =>
                active.runtime?.session.sessionManager === target.sessionManager
                  ? active.runtime.session
                  : undefined,
              ),
          },
        ],
      },
    });
    const { resourceLoader, modelRuntime } = services;
    const loaded = resourceLoader.getExtensions();
    const diagnostics = [...services.diagnostics];
    for (const { path, error } of loaded.errors)
      diagnostics.push({ type: "error", message: `Failed to load extension ${path}: ${error}` });
    for (const { path, warning } of loaded.warnings ?? [])
      diagnostics.push({ type: "warning", message: `${path}: ${warning}` });
    for (const { scope, error } of settingsManager.drainErrors())
      diagnostics.push({ type: "error", message: `${scope} settings: ${error.message}` });
    const failure = diagnostics.find((d) => d.type === "error");
    if (failure) throw new Error(failure.message);
    // The CLI loader treats an unreadable path as literal prompt text. This argument always
    // names our launcher's file, so never send its filename in place of the child's instructions.
    const instructions = readFileSync(policy.prompt, "utf8").replace(/^\uFEFF/u, "");
    if (!resourceLoader.getAppendSystemPrompt().includes(instructions))
      throw new Error("Failed to load Rex child system prompt file.");
    const slash = policy.model.indexOf("/");
    const model = modelRuntime.getModel(
      policy.model.slice(0, slash),
      policy.model.slice(slash + 1),
    );
    if (!model || `${model.provider}/${model.id}` !== policy.model)
      throw new Error(`Rex child model unavailable: ${policy.model}`);
    const patterns = settingsManager.getEnabledModels();
    const scope = patterns?.length
      ? await sdk.resolveModelScopeWithDiagnostics(patterns, modelRuntime, {
          signal: AbortSignal.timeout(15_000),
        })
      : undefined;
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      ...(target.sessionStartEvent && { sessionStartEvent: target.sessionStartEvent }),
      model,
      thinkingLevel: policy.thinking,
      tools: policy.tools,
      excludeTools: policy.excludeTools,
      ...(scope && { scopedModels: scope.scopedModels }),
    });
    if (
      created.modelFallbackMessage ||
      created.session.model?.provider !== model.provider ||
      created.session.model.id !== model.id
    ) {
      created.session.dispose();
      throw new Error(`Rex child model changed during startup: ${policy.model}`);
    }
    // Persist the CLI override on resumes too; Pi clamps to the capabilities of the selected model.
    created.session.setThinkingLevel(created.session.thinkingLevel);
    return { ...created, services, diagnostics: [...diagnostics, ...(scope?.diagnostics ?? [])] };
  };
  active.runtime = await sdk.createAgentSessionRuntime(factory, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
  return active.runtime;
}

/** @param {string[]} args */
export async function runRexPiHost(args) {
  const sdk = await loadRexPiSdk();
  const globalSettings = sdk.SettingsManager.create(process.cwd(), sdk.getAgentDir(), {
    projectTrusted: false,
  }).getGlobalSettings();
  configureRexPiProxy(globalSettings.httpProxy, process.env);
  const runtime = await createRexPiRuntime(sdk, args);
  sdk.initTheme(runtime.services.settingsManager.getTheme(), true);
  const mode = new sdk.InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics] });
  try {
    await mode.run();
  } finally {
    mode.stop();
    await runtime.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runRexPiHost(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Rex Pi host: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
