import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { bundledLanguages } from "shiki";
import { nodePath, indexOfFrom } from "pi-cosmic-core";
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
  const normalized = Str.toLowerCase(language);
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
}

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
    path && JSX_LANGUAGES.get(Str.toLowerCase(nodePath.extname(path))),
    path && getLanguageFromPath(path),
    languageFromPath(path),
    languageFromShebang(content),
    languageFromContent(content),
  );
}

function languageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = Str.toLowerCase(nodePath.basename(path));
  if (Fn.pipe(name, Str.startsWith(".env")) || Fn.pipe(name, Str.endsWith(".env"))) return "dotenv";
  if (name === "dockerfile" || Fn.pipe(name, Str.startsWith("dockerfile."))) return "dockerfile";
  return EXACT_BASENAMES.get(name);
}

function languageFromShebang(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const newline = indexOfFrom(content, "\n", 0);
  const firstLine = Str.trim(newline < 0 ? content : Fn.pipe(content, Str.slice(0, newline)));
  if (!Fn.pipe(firstLine, Str.startsWith("#!"))) return undefined;
  const parts = Arr.filter(
    Str.split(Fn.pipe(firstLine, Str.replace(/^#!\s*/, "")), /\s+/),
    Str.isNonEmpty,
  );
  const envIndex = Arr.findFirstIndex(parts, (part) => nodePath.basename(part) === "env");
  const command = Option.isSome(envIndex)
    ? Option.getOrUndefined(
        Arr.findFirst(
          parts.slice(envIndex.value + 1),
          (part) => !Fn.pipe(part, Str.startsWith("-")),
        ),
      )
    : parts[0];
  if (!command) return undefined;
  return SHEBANG_ALIASES.get(
    Fn.pipe(nodePath.basename(command), Str.toLowerCase, Str.replace(/\d+(\.\d+)?$/, "")),
  );
}

function languageFromContent(content: string | undefined): string | undefined {
  if (!content || content.length > codePreviewPerformanceConfig.contentLanguageDetectionChars)
    return undefined;
  const trimmed = Str.trim(content);
  if (!trimmed) return undefined;
  if (
    (Fn.pipe(trimmed, Str.startsWith("{")) || Fn.pipe(trimmed, Str.startsWith("["))) &&
    isJson(trimmed)
  )
    return "json";
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
