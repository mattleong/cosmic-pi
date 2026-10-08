import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { bundledLanguages } from "shiki";
import { nodeBasename, nodeExtname } from "../boundary/node";
import { codePreviewPerformanceConfig } from "../config/state";

const EXACT_BASENAMES = new Map<string, string>([
  ["makefile", "makefile"],
  ["gnumakefile", "makefile"],
  ["justfile", "makefile"],
  ["procfile", "shellscript"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["cargo.lock", "toml"],
  ["composer.lock", "json"],
  ["yarn.lock", "yaml"],
]);

const LANGUAGE_ALIASES = new Map<string, string>([
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["shell-session", "shellscript"],
  ["shellsession", "shellscript"],
  ["terminal", "shellscript"],
  ["console", "shellscript"],
  ["ts", "typescript"],
  ["js", "javascript"],
  ["md", "markdown"],
  ["yml", "yaml"],
]);

export function normalizePreviewLanguageAlias(language: string): string {
  const normalized = language.toLowerCase();
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
}

/** Pi's extension table maps JSX sources to grammars without JSX. */
const JSX_LANGUAGES = new Map<string, string>([
  [".tsx", "tsx"],
  [".jsx", "jsx"],
]);

const SHEBANG_ALIASES = new Map<string, string>([
  ["bash", "bash"],
  ["sh", "bash"],
  ["zsh", "bash"],
  ["python", "python"],
  ["node", "javascript"],
  ["deno", "typescript"],
  ["ruby", "ruby"],
  ["php", "php"],
]);

export function resolvePreviewLanguage({
  path,
  content,
}: {
  path?: string | undefined;
  content?: string | undefined;
}): string | undefined {
  return firstSupported(
    path && JSX_LANGUAGES.get(nodeExtname(path).toLowerCase()),
    path && getLanguageFromPath(path),
    languageFromPath(path),
    languageFromShebang(content),
    languageFromContent(content),
  );
}

/** Names Pi's extension table does not know. */
function languageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = nodeBasename(path).toLowerCase();
  if (name.startsWith(".env") || name.endsWith(".env")) return "dotenv";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  return EXACT_BASENAMES.get(name);
}

function languageFromShebang(content: string | undefined): string | undefined {
  const firstLine = content?.split("\n", 1)[0]?.trim();
  if (!firstLine?.startsWith("#!")) return undefined;
  const parts = firstLine
    .replace(/^#!\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
  const envIndex = parts.findIndex((part) => nodeBasename(part) === "env");
  const command =
    envIndex >= 0 ? parts.slice(envIndex + 1).find((part) => !part.startsWith("-")) : parts[0];
  if (!command) return undefined;
  // Versioned interpreters such as python3 or ruby3.2 share their unversioned grammar.
  return SHEBANG_ALIASES.get(
    nodeBasename(command)
      .toLowerCase()
      .replace(/\d+(\.\d+)?$/, ""),
  );
}

function languageFromContent(content: string | undefined): string | undefined {
  if (!content || content.length > codePreviewPerformanceConfig.contentLanguageDetectionChars)
    return undefined;
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && isJson(trimmed)) return "json";
  if (/^<(!doctype\s+html|html)(\s|>)/i.test(trimmed)) return "html";
  if (/^<\?xml\s/i.test(trimmed)) return "xml";
  return undefined;
}

function firstSupported(...languages: Array<string | undefined>): string | undefined {
  for (const language of languages) {
    if (language && language in bundledLanguages) return language;
  }
  return undefined;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
